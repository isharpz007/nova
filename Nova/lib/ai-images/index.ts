// Image provider registry.
// Resolution order: explicit request → NOVA_IMAGE_PROVIDER env → first
// configured real provider (openai, then gemini). The mock provider is only
// resolvable outside production, for tests and local development.

import { geminiProvider } from "./gemini";
import { mockProvider } from "./mock";
import { openaiProvider } from "./openai";
import type { ImageProvider, ProviderCapabilities } from "./types";

export type ImageProviderId = "openai" | "gemini" | "mock";
export const IMAGE_PROVIDER_IDS: ImageProviderId[] = ["openai", "gemini", "mock"];

const registry: Record<ImageProviderId, ImageProvider> = {
  openai: openaiProvider,
  gemini: geminiProvider,
  mock: mockProvider,
};

function configured(id: ImageProviderId): boolean {
  switch (id) {
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "mock":
      return process.env.NODE_ENV !== "production";
  }
}

/** Providers that are actually usable right now (credentials present). */
export function listImageProviders(): ProviderCapabilities[] {
  return IMAGE_PROVIDER_IDS.filter(configured).map((id) => registry[id].capabilities());
}

/**
 * Resolves a provider. `requested` must be a known id that is configured;
 * without it, env pin → openai → gemini. Returns null when nothing usable
 * exists (the UI should report "no image provider configured").
 */
export function getImageProvider(requested?: string): ImageProvider | null {
  if (requested) {
    if (!IMAGE_PROVIDER_IDS.includes(requested as ImageProviderId)) return null;
    const id = requested as ImageProviderId;
    return configured(id) ? registry[id] : null;
  }
  const env = process.env.NOVA_IMAGE_PROVIDER as ImageProviderId | undefined;
  if (env && IMAGE_PROVIDER_IDS.includes(env) && configured(env)) return registry[env];
  if (configured("openai")) return openaiProvider;
  if (configured("gemini")) return geminiProvider;
  return null;
}

export { ProviderError } from "./types";
export type {
  EditRequest,
  GenerateRequest,
  GeneratedImage,
  ImageProvider,
  ImageSize,
  ProviderCapabilities,
} from "./types";
