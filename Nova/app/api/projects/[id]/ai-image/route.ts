import { NextRequest, NextResponse } from "next/server";
import { requireOwnedProject } from "@/lib/projects";
import {
  getImageProvider,
  listImageProviders,
  ProviderError,
  type ImageSize,
} from "@/lib/ai-images";
import { IMAGE_SIZES } from "@/lib/ai-images/types";

const PROMPT_MAX = 2000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp"]);

type Ctx = { params: Promise<{ id: string }> };

// per-user sliding window — provider calls are expensive
const buckets = ((globalThis as Record<string, unknown>).__novaAiRate ??=
  new Map<string, number[]>()) as Map<string, number[]>;

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const arr = (buckets.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    buckets.set(userId, arr);
    return true;
  }
  arr.push(now);
  buckets.set(userId, arr);
  return false;
}

function err(e: unknown): NextResponse {
  if (e instanceof ProviderError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
  if (e instanceof DOMException && e.name === "AbortError") {
    return NextResponse.json({ error: "Generation cancelled" }, { status: 499 });
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return NextResponse.json({ error: "Image provider timed out — try again" }, { status: 504 });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message.slice(0, 200) : "Image generation failed" },
    { status: 502 }
  );
}

/** What the studio can offer with the providers currently configured. */
export async function GET(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const check = await requireOwnedProject(request, id);
  if (check instanceof NextResponse) return check;
  return NextResponse.json({ providers: listImageProviders() });
}

/**
 * POST { action: "generate" | "edit", prompt, size?, count?, provider?,
 *        assetPath? (edit: stored asset to modify) }
 * Returns { images: [{ b64, mediaType }] } — transient previews; pixels are
 * only persisted when the client explicitly uploads via the assets route.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const check = await requireOwnedProject(request, id);
  if (check instanceof NextResponse) return check;
  const { supabase, user } = check;

  if (rateLimited(user.id)) {
    return NextResponse.json({ error: "Too many requests — slow down" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = getImageProvider(typeof body.provider === "string" ? body.provider : undefined);
  if (!provider) {
    return NextResponse.json(
      { error: "No image-generation provider is configured" },
      { status: 503 }
    );
  }
  const caps = provider.capabilities();

  const action = body.action;
  if (action !== "generate" && action !== "edit") {
    return NextResponse.json({ error: "action must be generate or edit" }, { status: 400 });
  }
  if (action === "edit" && !caps.edit) {
    return NextResponse.json(
      { error: `${caps.label} does not support image editing` },
      { status: 400 }
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > PROMPT_MAX) {
    return NextResponse.json(
      { error: `prompt must be 1–${PROMPT_MAX} characters` },
      { status: 400 }
    );
  }

  const size: ImageSize =
    typeof body.size === "string" && IMAGE_SIZES.includes(body.size as ImageSize)
      ? (body.size as ImageSize)
      : "auto";
  if (!caps.sizes.includes(size)) {
    return NextResponse.json({ error: `size ${size} not supported by ${caps.label}` }, { status: 400 });
  }

  try {
    if (action === "generate") {
      const count = Math.min(
        caps.maxCount,
        Math.max(1, typeof body.count === "number" ? Math.floor(body.count) : 1)
      );
      const images = await provider.generate({ prompt, size, count, signal: request.signal });
      return NextResponse.json({ images, provider: caps.id });
    }

    // edit: resolve the stored asset (must belong to this user + project)
    const assetPath = typeof body.assetPath === "string" ? body.assetPath : "";
    const prefix = `${user.id}/${id}/`;
    if (!assetPath.startsWith(prefix)) {
      return NextResponse.json({ error: "Invalid asset reference" }, { status: 400 });
    }
    const { data: blob, error: dlErr } = await supabase.storage
      .from("project-assets")
      .download(assetPath);
    if (dlErr || !blob) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length > MAX_ASSET_BYTES) {
      return NextResponse.json({ error: "Asset too large to edit" }, { status: 413 });
    }
    const mediaType = ALLOWED_MEDIA.has(blob.type) ? blob.type : "image/png";
    const images = await provider.edit({
      prompt,
      image: { b64: buf.toString("base64"), mediaType },
      size,
      signal: request.signal,
    });
    return NextResponse.json({ images, provider: caps.id });
  } catch (e) {
    return err(e);
  }
}
