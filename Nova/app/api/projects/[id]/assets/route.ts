import { NextRequest, NextResponse } from "next/server";
import { requireOwnedProject } from "@/lib/projects";
import { randomUUID } from "node:crypto";

type Ctx = { params: Promise<{ id: string }> };

const BUCKET = "project-assets";
const MAX_BYTES = 8 * 1024 * 1024;

const MAGIC: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/png", ext: "png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
];

function detect(buf: Buffer): { mime: string; ext: string } | null {
  return MAGIC.find((m) => m.test(buf)) ?? null;
}

/**
 * POST { b64, mediaType? } — persists a generated/edited image as a private
 * project asset. Bytes are magic-byte validated; the declared type is never
 * trusted. Returns { assetPath } — the value stored on ImageElements.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const check = await requireOwnedProject(request, id);
  if (check instanceof NextResponse) return check;
  const { supabase, user } = check;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b64 = typeof body.b64 === "string" ? body.b64 : "";
  if (!b64 || b64.length > MAX_BYTES * 1.4) {
    return NextResponse.json({ error: "Missing or oversized image data" }, { status: 400 });
  }
  const buf = Buffer.from(b64, "base64");
  if (!buf.length || buf.length > MAX_BYTES) {
    return NextResponse.json({ error: `Image must be ${MAX_BYTES / 1024 / 1024}MB or smaller` }, { status: 413 });
  }
  const kind = detect(buf);
  if (!kind) {
    return NextResponse.json({ error: "Only PNG, JPEG and WebP images are allowed" }, { status: 400 });
  }

  const assetPath = `${user.id}/${id}/img_${randomUUID()}.${kind.ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(assetPath, buf, {
    contentType: kind.mime,
    upsert: false,
  });
  if (error) {
    return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ assetPath });
}

/**
 * GET ?path=<assetPath> — authenticated proxy for private assets so
 * <img>/canvas loading never needs public URLs or client-side credentials.
 * Only paths inside this user's folder for this project are served.
 */
export async function GET(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const check = await requireOwnedProject(request, id);
  if (check instanceof NextResponse) return check;
  const { supabase, user } = check;

  const path = request.nextUrl.searchParams.get("path") ?? "";
  const prefix = `${user.id}/${id}/`;
  if (!path.startsWith(prefix) || path.includes("..")) {
    return NextResponse.json({ error: "Invalid asset path" }, { status: 400 });
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }
  return new NextResponse(data, {
    headers: {
      "Content-Type": data.type || "application/octet-stream",
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
