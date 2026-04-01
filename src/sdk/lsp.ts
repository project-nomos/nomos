/**
 * LSP integration — Language Server Protocol tools for code intelligence.
 *
 * Spawns a TypeScript language server (tsserver) and communicates via
 * stdin/stdout using the LSP JSON-RPC protocol. Provides go-to-definition,
 * find-references, hover, and document-symbols capabilities.
 *
 * The server is lazily initialized on first tool call and reused across calls.
 * It shuts down gracefully when the process exits.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";

interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface LspSymbol {
  name: string;
  kind: number;
  range: LspLocation["range"];
  selectionRange: LspLocation["range"];
  children?: LspSymbol[];
}

interface LspHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LspLocation["range"];
}

/** Maps LSP SymbolKind numbers to readable names. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

let lspProcess: ChildProcess | null = null;
let messageId = 0;
let initialized = false;
let initPromise: Promise<void> | null = null;
const pendingRequests = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();
let buffer = "";

function fileUri(filePath: string): string {
  const abs = resolve(filePath);
  return `file://${abs}`;
}

function uriToPath(uri: string): string {
  return uri.replace("file://", "");
}

/** Start the LSP server and initialize it. */
async function ensureServer(rootPath?: string): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const root = rootPath ?? process.cwd();

    // Try typescript-language-server first, fall back to tsserver wrapper
    lspProcess = spawn("npx", ["typescript-language-server", "--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    lspProcess.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!contentLengthMatch) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(contentLengthMatch[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) break;

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);

        try {
          const msg: LspMessage = JSON.parse(body);
          if (msg.id !== undefined && pendingRequests.has(msg.id)) {
            const pending = pendingRequests.get(msg.id)!;
            pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch {
          // Malformed message, skip
        }
      }
    });

    lspProcess.on("exit", () => {
      lspProcess = null;
      initialized = false;
      initPromise = null;
    });

    // Send initialize request
    const initResult = await sendRequest("initialize", {
      processId: process.pid,
      rootUri: fileUri(root),
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    });

    // Send initialized notification
    sendNotification("initialized", {});

    if (!initResult) {
      throw new Error("LSP server failed to initialize");
    }

    initialized = true;

    // Cleanup on exit
    process.on("exit", () => {
      if (lspProcess) {
        try {
          sendNotification("shutdown", {});
        } catch {
          /* ignore */
        }
        lspProcess.kill();
      }
    });
  })();

  return initPromise;
}

function sendMessage(msg: LspMessage): void {
  if (!lspProcess?.stdin) throw new Error("LSP server not running");
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  lspProcess.stdin.write(header + body);
}

function sendNotification(method: string, params: unknown): void {
  sendMessage({ jsonrpc: "2.0", method, params });
}

function sendRequest(method: string, params: unknown): Promise<unknown> {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`LSP request timed out: ${method}`));
    }, 15000);

    pendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    sendMessage({ jsonrpc: "2.0", id, method, params });
  });
}

/** Open a file in the LSP server (required before querying it). */
async function openFile(filePath: string): Promise<void> {
  const absPath = resolve(filePath);
  const content = await readFile(absPath, "utf-8");
  const uri = fileUri(absPath);

  sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: absPath.endsWith(".tsx")
        ? "typescriptreact"
        : absPath.endsWith(".jsx")
          ? "javascriptreact"
          : absPath.endsWith(".js") || absPath.endsWith(".mjs")
            ? "javascript"
            : "typescript",
      version: 1,
      text: content,
    },
  });
}

/**
 * Go to the definition of a symbol at the given position.
 * Returns the file path and line number of the definition.
 */
export async function goToDefinition(
  filePath: string,
  line: number,
  character: number,
): Promise<{ path: string; line: number; character: number }[]> {
  await ensureServer(dirname(filePath));
  await openFile(filePath);

  const result = await sendRequest("textDocument/definition", {
    textDocument: { uri: fileUri(filePath) },
    position: { line: line - 1, character }, // Convert 1-based to 0-based
  });

  if (!result) return [];

  const locations = Array.isArray(result) ? result : [result];
  return (locations as LspLocation[]).map((loc) => ({
    path: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    character: loc.range.start.character,
  }));
}

/**
 * Find all references to a symbol at the given position.
 */
export async function findReferences(
  filePath: string,
  line: number,
  character: number,
  includeDeclaration = true,
): Promise<{ path: string; line: number; character: number }[]> {
  await ensureServer(dirname(filePath));
  await openFile(filePath);

  const result = await sendRequest("textDocument/references", {
    textDocument: { uri: fileUri(filePath) },
    position: { line: line - 1, character },
    context: { includeDeclaration },
  });

  if (!result) return [];

  return (result as LspLocation[]).map((loc) => ({
    path: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    character: loc.range.start.character,
  }));
}

/**
 * Get hover information (type info, docs) for a symbol at the given position.
 */
export async function hover(
  filePath: string,
  line: number,
  character: number,
): Promise<string | null> {
  await ensureServer(dirname(filePath));
  await openFile(filePath);

  const result = (await sendRequest("textDocument/hover", {
    textDocument: { uri: fileUri(filePath) },
    position: { line: line - 1, character },
  })) as LspHover | null;

  if (!result?.contents) return null;

  if (typeof result.contents === "string") return result.contents;
  if ("value" in result.contents) return result.contents.value;
  if (Array.isArray(result.contents)) {
    return result.contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  }

  return JSON.stringify(result.contents);
}

/**
 * Get document symbols (functions, classes, variables, etc.) for a file.
 */
export async function documentSymbols(
  filePath: string,
): Promise<{ name: string; kind: string; line: number; endLine: number; children?: unknown[] }[]> {
  await ensureServer(dirname(filePath));
  await openFile(filePath);

  const result = await sendRequest("textDocument/documentSymbol", {
    textDocument: { uri: fileUri(filePath) },
  });

  if (!result) return [];

  function mapSymbol(sym: LspSymbol): {
    name: string;
    kind: string;
    line: number;
    endLine: number;
    children?: unknown[];
  } {
    return {
      name: sym.name,
      kind: SYMBOL_KINDS[sym.kind] ?? `Unknown(${sym.kind})`,
      line: sym.range.start.line + 1,
      endLine: sym.range.end.line + 1,
      ...(sym.children?.length ? { children: sym.children.map(mapSymbol) } : {}),
    };
  }

  return (result as LspSymbol[]).map(mapSymbol);
}

/** Shut down the LSP server. */
export async function shutdownLsp(): Promise<void> {
  if (!lspProcess) return;
  try {
    await sendRequest("shutdown", {});
    sendNotification("exit", {});
  } catch {
    // Force kill if graceful shutdown fails
    lspProcess.kill();
  }
  lspProcess = null;
  initialized = false;
  initPromise = null;
}
