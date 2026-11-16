// Browser-side image element asset cache.
//
// The drawing engine renders synchronously, so image elements resolve through
// this cache: getAssetImage() returns the loaded <img> or null and kicks off a
// fetch the first time a path is seen. When a load finishes, the registered
// onReady callback fires so the studio can repaint and refresh thumbnails.
//
// Asset paths are opaque storage keys — a resolver maps them to fetchable
// URLs (the studio registers an auth-proxied API route).

export type ImageAssetStatus = "loading" | "ready" | "error";

interface CacheEntry {
  status: ImageAssetStatus;
  img?: HTMLImageElement;
}

const cache = new Map<string, CacheEntry>();
let resolver: (assetPath: string) => string = (p) => p;
let onReady: ((assetPath: string) => void) | null = null;
const listeners = new Set<(assetPath: string) => void>();

/** Sets how storage paths map to URLs. Call once per studio mount. */
export function setAssetResolver(fn: (assetPath: string) => string): void {
  resolver = fn;
}

/** Single primary callback (kept for the studio page's repaint hook). */
export function setImageReadyCallback(fn: ((assetPath: string) => void) | null): void {
  onReady = fn;
}

/** Extra listeners (e.g. tests). Returns an unsubscribe function. */
export function onImageReady(fn: (assetPath: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(path: string): void {
  try {
    onReady?.(path);
  } finally {
    for (const fn of listeners) {
      try {
        fn(path);
      } catch {
        /* listener errors must not break loading */
      }
    }
  }
}

/**
 * Returns the loaded image for an asset path, or null while loading/failed.
 * Kicks off the fetch on first sight. Safe to call every paint.
 */
export function getAssetImage(assetPath: string): HTMLImageElement | null {
  let entry = cache.get(assetPath);
  if (entry) return entry.status === "ready" ? entry.img! : null;
  if (typeof Image === "undefined") return null; // non-browser (tests)
  entry = { status: "loading" };
  cache.set(assetPath, entry);
  const img = new Image();
  img.onload = () => {
    entry!.status = "ready";
    entry!.img = img;
    notify(assetPath);
  };
  img.onerror = () => {
    entry!.status = "error";
    notify(assetPath);
  };
  img.src = resolver(assetPath);
  return null;
}

export function getAssetStatus(assetPath: string): ImageAssetStatus | "unknown" {
  return cache.get(assetPath)?.status ?? "unknown";
}

/** Drops a cached entry so the next render refetches (e.g. after replace). */
export function invalidateAsset(assetPath: string): void {
  cache.delete(assetPath);
}

/** Test helper — clears the whole cache. */
export function clearAssetCache(): void {
  cache.clear();
}
