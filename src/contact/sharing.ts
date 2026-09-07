import { getContactCard, sendMessage, uploadContactVCard } from '../linq/client.js';
import { randomUUID, createHash } from 'node:crypto';
import { getContactShareStatus, claimContactShare, completeContactShare, releaseContactShare } from '../state/contact.js';
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

export interface ShareContactRequest {
  chatId: string;
  botNumber?: string;
  person: string;
  incomingMessageId: string;
  service?: 'iMessage' | 'RCS' | 'SMS';
  isGroupChat: boolean;
  requestedByUser: boolean;
  message: string;
}

export type ShareContactResult = { status: 'sent' | 'skipped' | 'failed'; reason?: string };

export function createContactSharer(deps = {
  getContactCard, sendMessage, uploadContactVCard, downloadPhoto,
  getContactShareStatus, claimContactShare, completeContactShare, releaseContactShare,
}) {
  const attachments = new Map<string, { expiresAt: number; value: ReturnType<typeof uploadContactVCard> }>();

  async function attachmentFor(phone: string): ReturnType<typeof uploadContactVCard> {
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

  return async (request: ShareContactRequest): Promise<ShareContactResult> => {
    const { chatId, botNumber, person, incomingMessageId, service, requestedByUser, isGroupChat, message } = request;
    if (!botNumber || !person || !incomingMessageId) return { status: 'failed', reason: 'Missing contact-sharing destination' };
    if (!requestedByUser) {
      if (service !== 'RCS' || isGroupChat || process.env.RCS_CONTACT_CARD_ENABLED === 'false') return { status: 'skipped' };
      if (await deps.getContactShareStatus(botNumber, person) !== 'not_shared') return { status: 'skipped' };
    }
    const owner = randomUUID();
    const requestId = `${chatId}:${incomingMessageId}`;
    // Stable introduction keys also prevent duplicate sends if the process
    // stops after Linq accepts the file but before DynamoDB records success.
    const deliveryKey = createHash('sha256').update(JSON.stringify([
      botNumber, person, requestedByUser ? requestId : 'introduction',
    ])).digest('hex');
    let claimed = false;
    let accepted = false;
    try {
      claimed = await deps.claimContactShare(botNumber, person, requestId, owner, requestedByUser);
      if (!claimed) return { status: 'skipped', reason: 'Already shared or another send is in progress' };
      const attachment = await attachmentFor(botNumber);
      if (service === 'SMS' && (!attachment.downloadUrl || new URL(attachment.downloadUrl).protocol !== 'https:')) {
        throw new Error('No valid contact download link was returned');
      }
      // The model supplies the natural introduction. Sending it here means a
      // suppressed duplicate does not produce another "here is my contact".
      await deps.sendMessage(chatId, message, undefined, undefined, undefined, undefined, `${deliveryKey}:intro`);
      const sent = service === 'SMS'
        ? await deps.sendMessage(chatId, attachment.downloadUrl, undefined, undefined, undefined, undefined, `${deliveryKey}:file`)
        : await deps.sendMessage(chatId, '', undefined, undefined, [{ attachment_id: attachment.attachmentId }], undefined, `${deliveryKey}:file`);
      if (sent.message.delivery_status === 'failed') throw new Error('Linq rejected contact delivery');
      accepted = true;
      await deps.completeContactShare(botNumber, person, requestId, owner, sent.message.service ?? service ?? 'unknown', sent.message.id);
      console.log(`[contact] Tool shared VCF with chat ${chatId}`);
      return { status: 'sent' };
    } catch (error) {
      console.error('[contact] Tool failed:', error instanceof Error ? error.message : 'Unknown error');
      if (accepted) {
        // Do not tell the user the send failed if only the history write failed.
        // Keep the lease; the stable Linq idempotency key protects retries.
        return { status: 'sent', reason: 'Share history could not be updated' };
      }
      if (claimed) {
        try { await deps.releaseContactShare(botNumber, person, owner); }
        catch { console.error('[contact] Could not release share lease; it will expire'); }
      }
      return { status: 'failed', reason: 'Contact could not be sent' };
    }
  };
}

export const sendBotContact = createContactSharer();
