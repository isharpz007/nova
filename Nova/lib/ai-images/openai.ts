// OpenAI image provider — gpt-image models via /v1/images.
// Generation and edit both supported; results arrive as b64_json.

import {
  GeneratedImage,
  ImageProvider,
  ProviderCapabilities,
  ProviderError,
  upstreamError,
  type GenerateRequest,
  type EditRequest,
} from "./types";

const MODEL = () => process.env.NOVA_IMAGE_MODEL_OPENAI || "gpt-image-1-mini";
const BASE = "https://api.openai.com/v1/images";

function key(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new ProviderError("OpenAI is not configured", 503, "provider_not_configured");
  return k;
}

function timeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(90_000);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function parse(res: Response): Promise<{ b64_json?: string }[]> {
  const j = (await res.json().catch(() => ({}))) as {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
  };
  if (!res.ok) throw upstreamError("OpenAI", res.status, j.error?.message ?? res.statusText);
  const out = (j.data ?? []).filter((d) => d.b64_json);
  if (!out.length) throw new ProviderError("OpenAI returned no image data", 502, "provider_empty");
  return out as { b64_json: string }[];
}

export const openaiProvider: ImageProvider = {
  capabilities(): ProviderCapabilities {
    return {
      id: "openai",
      label: "OpenAI gpt-image",
      generate: true,
      edit: true,
      sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
      maxCount: 4,
    };
  },

  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    const res = await fetch(`${BASE}/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL(),
        prompt: req.prompt,
        size: req.size === "auto" ? "auto" : req.size,
        n: Math.min(4, Math.max(1, req.count)),
      }),
      signal: timeout(req.signal),
    });
    return (await parse(res)).map((d) => ({ b64: d.b64_json!, mediaType: "image/png" }));
  },

  async edit(req: EditRequest): Promise<GeneratedImage[]> {
    const bytes = Buffer.from(req.image.b64, "base64");
    const ext = req.image.mediaType.includes("jpeg") ? "jpg" : req.image.mediaType.includes("webp") ? "webp" : "png";
    const form = new FormData();
    form.set("model", MODEL());
    form.set("prompt", req.prompt);
    if (req.size && req.size !== "auto") form.set("size", req.size);
    form.set("image", new Blob([new Uint8Array(bytes)], { type: req.image.mediaType }), `image.${ext}`);
    const res = await fetch(`${BASE}/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
      signal: timeout(req.signal),
    });
    return (await parse(res)).map((d) => ({ b64: d.b64_json!, mediaType: "image/png" }));
  },
};
