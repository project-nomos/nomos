import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateOrigin } from "@/lib/validate-request";

const NOMOS_DIR = path.join(os.homedir(), ".nomos");
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

function getAvatarPath(): string | null {
  const extensions = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  for (const ext of extensions) {
    const p = path.join(NOMOS_DIR, `avatar.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
  };
  return map[mime] ?? "png";
}

/** GET — serve the current avatar */
export async function GET() {
  const avatarPath = getAvatarPath();
  if (!avatarPath) {
    return NextResponse.json({ hasAvatar: false }, { status: 200 });
  }

  const data = fs.readFileSync(avatarPath);
  const ext = path.extname(avatarPath).slice(1);
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
  };

  return new NextResponse(data, {
    headers: {
      "Content-Type": mimeMap[ext] ?? "image/png",
      "Cache-Control": "no-cache",
    },
  });
}

/** POST — upload a new avatar */
export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const formData = await request.formData();
  const file = formData.get("avatar") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "Invalid file type. Use PNG, JPEG, WebP, GIF, or SVG." },
      { status: 400 },
    );
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large. Max 2MB." }, { status: 400 });
  }

  // Remove existing avatar files
  const extensions = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  for (const ext of extensions) {
    const p = path.join(NOMOS_DIR, `avatar.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // Save new avatar
  fs.mkdirSync(NOMOS_DIR, { recursive: true });
  const ext = extFromMime(file.type);
  const savePath = path.join(NOMOS_DIR, `avatar.${ext}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(savePath, buffer);

  return NextResponse.json({ ok: true, path: savePath });
}

/** DELETE — remove the avatar */
export async function DELETE(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const extensions = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  for (const ext of extensions) {
    const p = path.join(NOMOS_DIR, `avatar.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  return NextResponse.json({ ok: true });
}
