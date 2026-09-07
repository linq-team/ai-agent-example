import { getContactCard, sendMessage, shareContactCard, uploadContactVCard } from '../linq/client.js';
import { createVCard, detectContactPhoto } from './vcard.js';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const ATTACHMENT_CACHE_MS = 60 * 60 * 1000;

async function downloadPhoto(url: string): Promise<Buffer> {
  if (new URL(url).protocol !== 'https:') throw new Error('Contact photo URL must use HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error(`Contact photo download failed: ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_PHOTO_BYTES) throw new Error('Contact photo exceeds 2 MiB');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

// A factory keeps the sharing policy independently testable. Production uses
// one instance below; no customer-specific contact data lives in this repo.
export function createContactSharer(deps = { getContactCard, sendMessage, shareContactCard, uploadContactVCard, downloadPhoto }) {
  const attachments = new Map<string, { expiresAt: number; value: Promise<string> }>();
  const shared = new Map<string, Promise<void>>();

  async function attachmentFor(phone: string): Promise<string> {
    const cached = attachments.get(phone);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = (async () => {
      const contact = await deps.getContactCard(phone);
      if (!contact) throw new Error('No active Linq contact card configured for this bot number');
      const photo = contact.image_url ? detectContactPhoto(await deps.downloadPhoto(contact.image_url)) : undefined;
      return deps.uploadContactVCard(createVCard(contact, photo));
    })();
    const entry = { expiresAt: Date.now() + ATTACHMENT_CACHE_MS, value };
    attachments.set(phone, entry);
    try { return await value; }
    catch (error) {
      if (attachments.get(phone) === entry) attachments.delete(phone);
      throw error;
    }
  }

  return async ({ chatId, botNumber, service, shareNative }: {
    chatId: string;
    botNumber?: string;
    service?: 'iMessage' | 'RCS' | 'SMS';
    shareNative: boolean;
  }): Promise<void> => {
    try {
      if (service === 'iMessage') {
        if (shareNative) await deps.shareContactCard(chatId);
        return;
      }
      if (service !== 'RCS' || process.env.RCS_CONTACT_CARD_ENABLED === 'false') return;
      if (!botNumber) throw new Error('Missing recipient_phone for RCS contact sharing');
      const key = `${botNumber}:${chatId}`;
      // Unlike native name/photo sharing, a VCF is a visible attachment. Send
      // it once per chat per process, not every five messages. Concurrent
      // incoming messages share the same in-flight send; failures can retry.
      if (shared.has(key)) return await shared.get(key);
      const send = (async () => {
        const attachmentId = await attachmentFor(botNumber);
        await deps.sendMessage(chatId, '', undefined, undefined, [{ attachment_id: attachmentId }]);
        console.log(`[contact] Shared VCF with chat ${chatId}`);
      })();
      shared.set(key, send);
      try { await send; }
      catch (error) {
        shared.delete(key);
        throw error;
      }
    } catch (error) {
      // Contact-sharing failures must never prevent the conversational reply.
      console.error('[contact] Sharing failed (non-fatal):', error instanceof Error ? error.message : 'Unknown error');
    }
  };
}

export const shareBotContact = createContactSharer();
