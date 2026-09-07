import type Anthropic from '@anthropic-ai/sdk';
import type { ContactShareStatus } from '../state/contact.js';

export const SEND_CONTACT_CARD_TOOL: Anthropic.Tool = {
  name: 'send_contact_card',
  description: 'Send your own saveable contact (VCF with your name, number and photo) to the CURRENT chat. Use whenever the user asks for your contact/card/vCard/VCF or asks you to resend it, on iMessage, RCS, or SMS. On SMS this sends a download link. You may also introduce it naturally early in an RCS conversation if contact-sharing context says it has not been shared. The tool sends ONLY the file or link, with no introductory text. Include a brief natural introduction once in your normal text response; do not claim delivery in advance.',
  input_schema: {
    type: 'object', properties: {
      requested_by_user: { type: 'boolean', description: 'True ONLY if the user asked for your contact or a resend; false for a proactive RCS introduction.' },
    }, required: ['requested_by_user'],
  },
};

export interface ContactCardRequest { requestedByUser: boolean }

export function parseContactCardRequest(input: unknown): ContactCardRequest | null {
  const value = input as { requested_by_user?: unknown } | null;
  if (typeof value?.requested_by_user !== 'boolean') return null;
  return { requestedByUser: value.requested_by_user };
}

export function contactSharingPrompt(status: ContactShareStatus, service?: string, isGroupChat = false): string {
  let prompt = '\n\n## Sharing your contact\nThe send_contact_card tool works on iMessage, RCS, and SMS (SMS gets a download link). When asked for your contact or to resend it, call the tool with requested_by_user=true, even if previously shared. Native iMessage name/photo sharing is separate and does not count as sending a VCF. Do not say you sent a file without calling the tool.';
  if (status === 'shared') prompt += '\nA VCF or download link was already sent to this person by this bot. Do not proactively repeat it; explicit resends are welcome.';
  else if (status === 'unknown') prompt += '\nShare history is unavailable. Do not proactively send a contact; still handle explicit requests.';
  else if (service === 'RCS' && !isGroupChat && process.env.RCS_CONTACT_CARD_ENABLED !== 'false') {
    prompt += '\nYou have not shared your VCF with this person yet. Work it naturally into an early reply using send_contact_card with requested_by_user=false. In an ordinary greeting or first-time introduction, call the tool in this reply alongside your greeting; do not wait for them to ask. Defer if the topic is urgent or sensitive, or they asked you not to send it. Write one short friendly introduction in your normal text response. The tool sends only the file or link and no additional introductory message.';
  } else prompt += '\nOnly send a VCF when requested in this conversation; do not proactively introduce it here.';
  return prompt;
}
