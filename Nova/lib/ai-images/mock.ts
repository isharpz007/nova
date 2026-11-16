// Deterministic mock provider for automated tests and local development.
// It encodes a real PNG (seeded by the prompt + variation index) with a tiny
// dependency-free PNG writer, so browser tests can assert on real pixels —
// never a placeholder or a fake success flag.
// Only resolvable when NODE_ENV !== "production" (see ./index.ts).

import { deflateSync } from "node:zlib";
import {
  GeneratedImage,
  ImageProvider,
  ImageSize,
  ProviderCapabilities,
  type GenerateRequest,
  type EditRequest,
} from "./types";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes raw RGBA pixels into a PNG. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (1 + w * 4) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const DIMS: Record<Exclude<ImageSize, "auto">, [number, number]> = {
  "1024x1024": [256, 256],
  "1536x1024": [384, 256],
  "1024x1536": [256, 384],
};

/** Builds a deterministic test image: seeded gradient + center disc. */
export function mockImage(seedText: string, size: ImageSize, variant: number): GeneratedImage {
  const [w, h] = DIMS[size === "auto" ? "1024x1024" : size];
  const seed = hash(seedText) + variant * 7919;
  const r0 = 40 + (seed % 160);
  const g0 = 40 + ((seed >> 7) % 160);
  const b0 = 40 + ((seed >> 14) % 160);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (r0 + x) % 256;
      rgba[i + 1] = (g0 + y) % 256;
      rgba[i + 2] = (b0 + ((x + y) >> 1)) % 256;
      rgba[i + 3] = 255;
    }
  }
  // center disc marks the image as mock-generated (verifiable in tests)
  const cx = w >> 1, cy = h >> 1, r = Math.min(w, h) >> 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * w + x) * 4;
        rgba[i] = 255 - r0;
        rgba[i + 1] = 255 - g0;
        rgba[i + 2] = 255 - b0;
        rgba[i + 3] = 255;
      }
    }
  }
  return { b64: encodePng(w, h, rgba).toString("base64"), mediaType: "image/png" };
}

export const mockProvider: ImageProvider = {
  capabilities(): ProviderCapabilities {
    return {
      id: "mock",
      label: "Mock (test only)",
      generate: true,
      edit: true,
      sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
      maxCount: 4,
    };
  },
  async generate(req: GenerateRequest): Promise<GeneratedImage[]> {
    const n = Math.min(4, Math.max(1, req.count));
    return Array.from({ length: n }, (_, i) => mockImage(req.prompt, req.size, i));
  },
  async edit(req: EditRequest): Promise<GeneratedImage[]> {
    // Echo-style edit: deterministic image seeded by original bytes + prompt.
    return [mockImage(req.prompt + req.image.b64.slice(0, 32), req.size ?? "1024x1024", 1)];
  },
};
