// Provider-independent AI image interface.
// Adapters implement generate/edit against a real provider SDK/API;
// the studio only ever sees these types.

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";
export const IMAGE_SIZES: ImageSize[] = ["1024x1024", "1536x1024", "1024x1536", "auto"];

export interface GeneratedImage {
  /** base64-encoded image bytes (png/jpeg/webp). Never stored in the doc. */
  b64: string;
  mediaType: string;
}

export interface GenerateRequest {
  prompt: string;
  size: ImageSize;
  count: number;
  signal?: AbortSignal;
}

export interface EditRequest {
  prompt: string;
  image: { b64: string; mediaType: string };
  size?: ImageSize;
  signal?: AbortSignal;
}

export interface ProviderCapabilities {
  id: string;
  label: string;
  generate: boolean;
  edit: boolean;
  sizes: ImageSize[];
  maxCount: number;
}

export interface ImageProvider {
  capabilities(): ProviderCapabilities;
  generate(req: GenerateRequest): Promise<GeneratedImage[]>;
  edit(req: EditRequest): Promise<GeneratedImage[]>;
}

/** Provider-side failure with a sanitized, user-safe message. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 502,
    public readonly code: string = "provider_error"
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Maps upstream HTTP failures to a stable error surface. */
export function upstreamError(provider: string, status: number, detail: string): ProviderError {
  const safe = detail.replace(/sk-[A-Za-z0-9_-]+|key=[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
  if (status === 401 || status === 403) {
    return new ProviderError(`${provider} credentials were rejected`, 502, "provider_auth");
  }
  if (status === 429) {
    return new ProviderError(`${provider} rate limit or quota reached — try again later`, 429, "provider_quota");
  }
  if (status === 400) {
    return new ProviderError(`${provider} rejected the request: ${safe}`, 400, "provider_bad_request");
  }
  if (status >= 500) {
    return new ProviderError(`${provider} is temporarily unavailable`, 502, "provider_unavailable");
  }
  return new ProviderError(`${provider} error (${status}): ${safe}`, 502, "provider_error");
}
