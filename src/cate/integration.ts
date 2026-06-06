/**
 * Nomos CATE integration — sets up CATE identity, policy, and
 * server for agent-to-agent communication.
 *
 * Creates a DID for the Nomos agent, issues "acts-for" VCs,
 * and configures the policy engine from DB config.
 */

import { CATEServer, createDIDKey, issueActsForVC, createAgentCard } from "@project-nomos/cate-sdk";
import type { CATEEnvelope, AgentCard } from "@project-nomos/cate-sdk";
import type { PolicyConfig } from "@project-nomos/cate-sdk/types";
import { NomosKeystore } from "./nomos-keystore.ts";
import { NomosTransport } from "./nomos-transport.ts";
import { getDb } from "../db/client.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("cate-integration");

const AGENT_KEY_ID = "nomos-agent";
const USER_KEY_ID = "nomos-user";

export interface CATEIntegration {
  server: CATEServer;
  agentDid: string;
  agentCard: AgentCard;
  keystore: NomosKeystore;
  transport: NomosTransport;
}

/**
 * Initialize CATE integration for the Nomos daemon.
 *
 * 1. Creates or loads agent DID from keystore
 * 2. Issues "acts-for" VC (agent acts on behalf of user)
 * 3. Creates signed agent card
 * 4. Configures policy from DB
 * 5. Starts CATE server
 */
export async function initCATEIntegration(options?: {
  port?: number;
  onMessage?: (envelope: CATEEnvelope) => void | Promise<void>;
}): Promise<CATEIntegration> {
  const keystore = new NomosKeystore();

  // Create or load agent key
  let agentKey = await keystore.getKey(AGENT_KEY_ID);
  if (!agentKey) {
    agentKey = await keystore.generateKey(AGENT_KEY_ID);
    log.info("Generated new agent key pair");
  }

  // Create or load user key (for VC issuance)
  let userKey = await keystore.getKey(USER_KEY_ID);
  if (!userKey) {
    userKey = await keystore.generateKey(USER_KEY_ID);
    log.info("Generated new user key pair");
  }

  const agentDid = createDIDKey(agentKey.publicKey);
  const userDid = createDIDKey(userKey.publicKey);

  // Issue "acts-for" VC
  const vc = await issueActsForVC(keystore, {
    userDid,
    userKeyId: USER_KEY_ID,
    agentDid,
    scope: ["communicate", "schedule", "draft"],
  });

  // Load agent identity from config
  const sql = getDb();
  const [identityConfig] = await sql<{ value: string }[]>`
    SELECT value FROM config WHERE key = 'app.agentName'
  `;
  const agentName = identityConfig?.value ? JSON.parse(identityConfig.value) : "Nomos Agent";

  // Create signed agent card
  const port = options?.port ?? 8801;
  const agentCard = await createAgentCard(keystore, AGENT_KEY_ID, {
    did: agentDid,
    name: agentName,
    description: "Personal AI agent powered by Nomos",
    version: "1.0",
    url: `http://localhost:${port}`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      encryption: false,
      stamps: true,
    },
    skills: [],
    endpoints: {
      cate: `http://localhost:${port}/cate`,
    },
    vc_chain: [JSON.stringify(vc)],
  });

  // Load policy config from DB
  const policyConfig = await loadPolicyConfig();

  // Create transport and server
  const transport = new NomosTransport({ port });

  const server = new CATEServer({
    identity: { did: agentDid, keystore },
    policy: policyConfig,
    onMessage: async (envelope, context) => {
      log.info(
        {
          senderDid: context.senderDid,
          trustTier: context.trustTier,
          policyAction: context.policyAction,
        },
        "Received envelope",
      );

      // Append to the inbox queue (lazy import to avoid pulling in DB code
      // at module init; some tests import CATEIntegration without a DB).
      try {
        const { enqueueInbound } = await import("./inbound-queue.ts");
        const rawEnv = envelope as unknown as Record<string, unknown>;
        const subject =
          typeof rawEnv.subject === "string"
            ? rawEnv.subject
            : typeof rawEnv.intent === "string"
              ? rawEnv.intent
              : undefined;
        const body =
          typeof rawEnv.body === "string"
            ? rawEnv.body
            : typeof rawEnv.message === "string"
              ? rawEnv.message
              : undefined;
        const bond = rawEnv.bond as { amount?: string | number; currency?: string } | undefined;
        await enqueueInbound({
          fromDid: context.senderDid,
          fromLabel: typeof rawEnv.from_label === "string" ? rawEnv.from_label : undefined,
          subject,
          body,
          bondAmount: bond?.amount != null ? String(bond.amount) : undefined,
          bondCurrency: bond?.currency,
          envelope: rawEnv,
        });
      } catch (err) {
        log.error({ err }, "Failed to enqueue inbound CATE envelope");
      }

      await options?.onMessage?.(envelope);
    },
    onError: (error) => {
      log.error({ err: error }, "Error");
    },
  });

  await server.listen({ transport });
  log.info({ port, agentDid }, "Server started");

  return { server, agentDid, agentCard, keystore, transport };
}

async function loadPolicyConfig(): Promise<PolicyConfig> {
  const sql = getDb();
  const [config] = await sql<{ value: string }[]>`
    SELECT value FROM config WHERE key = 'app.catePolicyConfig'
  `;

  if (config?.value) {
    try {
      return JSON.parse(config.value);
    } catch {
      // Fall through to defaults
    }
  }

  // Default policy: allow personal/system, require stamp for promotional
  return {
    default_action: "deny",
    rules: [
      {
        name: "allow-personal",
        match: { intent: ["personal", "system"] },
        action: "allow",
        priority: 10,
      },
      {
        name: "allow-transactional",
        match: { intent: ["transactional"] },
        action: "require_approval",
        priority: 5,
      },
      {
        name: "require-stamp-promotional",
        match: { intent: ["promotional"] },
        action: "require_stamp",
        stamp_requirement: {
          required: true,
          accepted_types: ["micropayment", "pow"],
          pow: { difficulty: 20, algorithm: "sha256" },
        },
        priority: 0,
      },
    ],
  };
}

/**
 * Stop the CATE integration.
 */
export async function stopCATEIntegration(integration: CATEIntegration): Promise<void> {
  await integration.server.close();
  log.info("Server stopped");
}
