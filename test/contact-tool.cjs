const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ANTHROPIC_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
const Anthropic = require('@anthropic-ai/sdk');
const conversation = require('../dist/state/conversation.js');
const { chat } = require('../dist/claude/client.js');
const { contactSharingPrompt, parseContactCardRequest } = require('../dist/contact/tool.js');

test('contact prompt introduces only when appropriate and permits requested resends', () => {
  assert.match(contactSharingPrompt('not_shared', 'RCS'), /Work it naturally into an early reply/);
  assert.doesNotMatch(contactSharingPrompt('shared', 'RCS'), /Work it naturally/);
  assert.match(contactSharingPrompt('shared', 'RCS'), /explicit resends are welcome/);
  assert.match(contactSharingPrompt('unknown', 'RCS'), /Do not proactively send/);
  for (const service of ['iMessage', 'SMS']) assert.match(contactSharingPrompt('not_shared', service), /Only send a VCF when requested/);
  assert.match(contactSharingPrompt('not_shared', 'RCS', true), /Only send a VCF when requested/);
  assert.equal(parseContactCardRequest({ requested_by_user: 'false', message: 'hi' }), null);
});

test('Claude receives the tool on every service; a tool-only response reaches the app as a contact action', async () => {
  const originalCreate = Anthropic.Messages.prototype.create;
  const originalGet = conversation.getConversation;
  const originalAdd = conversation.addMessage;
  conversation.getConversation = async () => [];
  conversation.addMessage = async () => {};
  try {
    for (const service of ['iMessage', 'RCS', 'SMS']) {
      Anthropic.Messages.prototype.create = async options => {
        assert.ok(options.tools.some(t => t.name === 'send_contact_card'));
        assert.match(options.system, /A VCF or download link was already sent/);
        return { content: [{ type: 'tool_use', name: 'send_contact_card', id: 'tool', input: { requested_by_user: true, message: 'here’s my contact' } }] };
      };
      const result = await chat('chat', 'can you resend your contact?', [], [], {
        isGroupChat: false, participantNames: [], chatName: null, service, contactShareStatus: 'shared',
      });
      assert.equal(result.text, null);
      assert.deepEqual(result.contactCard, { requestedByUser: true });
    }
  } finally {
    Anthropic.Messages.prototype.create = originalCreate;
    conversation.getConversation = originalGet;
    conversation.addMessage = originalAdd;
  }
});
