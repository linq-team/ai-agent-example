import { randomUUID } from 'crypto';

// In-memory store for generated images. The gpt-image models return base64
// (no hosted URL like DALL-E did), but the Linq API needs a fetchable URL for
// media parts - so we hold the bytes briefly and serve them from this app.
// Linq downloads media as soon as the message is sent, so a short TTL is fine.
// Only safe while the app runs as a single instance.
const TTL_MS = 15 * 60 * 1000;

interface StoredImage {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

const store = new Map<string, StoredImage>();

// Base URL images are served from. PUBLIC_BASE_URL wins if set; otherwise
// learned from the Host header of incoming webhook requests (works for both
// App Runner and ngrok without extra config).
let publicBaseUrl: string | null = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null;

export function setPublicBaseUrl(url: string): void {
  if (!process.env.PUBLIC_BASE_URL) {
    publicBaseUrl = url.replace(/\/+$/, '');
  }
}

export function storeImage(buffer: Buffer, contentType: string): string | null {
  if (!publicBaseUrl) {
    console.error('[imageStore] No public base URL known yet - cannot serve generated image');
    return null;
  }
  cleanup();
  const id = randomUUID();
  store.set(id, { buffer, contentType, expiresAt: Date.now() + TTL_MS });
  console.log(`[imageStore] Stored image ${id} (${Math.round(buffer.byteLength / 1024)}KB, ${store.size} in store)`);
  return `${publicBaseUrl}/images/${id}`;
}

export function getImage(id: string): { buffer: Buffer; contentType: string } | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return { buffer: entry.buffer, contentType: entry.contentType };
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id);
  }
}
