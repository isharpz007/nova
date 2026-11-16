// Gemini image provider — gemini-*-image models via generateContent.
// Both generation (text → image) and editing (text+image → image) are
// supported through the same multimodal endpoint.

import {
  GeneratedImage,
  ImageProvider,
  ImageSize,
  ProviderCapabilities,
  ProviderError,
  upstreamError,
  type GenerateRequest,
  type EditRequest,
} from "./types";

const MODEL = () => process.env.NOVA_IMAGE_MODEL_GEMINI || "gemini-2.5-flash-image";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ASPECT: Record<Exclude<ImageSize, "auto">, string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

function key(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new ProviderError("Gemini is not configured", 503, "provider_not_configured");
  return k;
}

function timeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(90_000);
  return signal ? AbortSignal.any([signal, t]) : t;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

async function call(parts: GeminiPart[], size: ImageSize | undefined, signal?: AbortSignal): Promise<GeneratedImage[]> {
  const body: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  if (size && size !== "auto") {
    (body.generationConfig as Record<string, unknown>).imageConfig = { aspectRatio: ASPECT[size] };
  }
  const res = await fetch(`${BASE}/${MODEL()}:generateContent?key=${key()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(signal),
  });
  const j = (await res.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: GeminiPart[] } }[];
    error?: { message?: string; status?: string };
  };
  if (!res.ok) throw upstreamError("Gemini", res.status, j.error?.message ?? res.statusText);
  const imgs: GeneratedImage[] = [];
  for (const c of j.candidates ?? []) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) imgs.push({ b64: p.inlineData.data, mediaType: p.inlineData.mimeType || "image/png" });
    }
  }
  if (!imgs.length) throw new ProviderError("Gemini returned no image data", 502, "provider_empty");
  return imgs;
}

export const geminiProvider: ImageProvider = {
  capabilities(): ProviderCapabilities {
    return {
      id: "gemini",
      label: "Gemini image",
      generate: true,
      edit: true,
      sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
      maxCount: 3,
    };
  },

  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    // The image API returns one image per call — issue parallel calls for
    // variations, capped by maxCount.
    const n = Math.min(3, Math.max(1, req.count));
    const out = await Promise.all(
      Array.from({ length: n }, () => call([{ text: req.prompt }], req.size, req.signal))
    );
    return out.flat();
  },

  async edit(req: EditRequest): Promise<GeneratedImage[]> {
    return call(
      [
        { text: req.prompt },
        { inlineData: { mimeType: req.image.mediaType, data: req.image.b64 } },
      ],
      req.size,
      req.signal
    );
  },
};
