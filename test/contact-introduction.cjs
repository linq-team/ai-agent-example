const { test } = require('node:test');
const assert = require('node:assert/strict');

test('full webhook flow sends the model introduction once, even with a legacy duplicate tool message', async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.LINQ_API_TOKEN = 'test';
  process.env.LINQ_AGENT_BOT_NUMBERS = '+14155550100';
  process.env.ALLOWED_SENDERS = '';
  process.env.IGNORED_SENDERS = '';
  process.env.RCS_CONTACT_CARD_ENABLED = 'true';

  const express = require('express');
  const Anthropic = require('@anthropic-ai/sdk');
  const linq = require('../dist/linq/client.js');
  const conversation = require('../dist/state/conversation.js');
  const usage = require('../dist/state/usage.js');
  const contactState = require('../dist/state/contact.js');
  const restore = [];
  const replace = (object, key, value) => {
    const original = object[key];
    restore.push(() => { object[key] = original; });
    object[key] = value;
  };
  const sent = [];
  const remembered = [];
  let webhook;
  let service;
  const intro = "btw here's my contact if you wanna save me";

  try {
    replace(global, 'fetch', async () => { throw new Error('Unexpected network call in regression test'); });
    replace(express.application, 'post', function (path, handler) {
      if (path === '/webhook') webhook = handler;
      return this;
    });
    replace(express.application, 'listen', () => ({}));
    replace(linq, 'getChat', async () => ({ id: 'chat', display_name: null, is_group: false, handles: [{ handle: '+14155550100' }, { handle: '+14155550200' }] }));
    replace(linq, 'markAsRead', async () => {});
    replace(linq, 'startTyping', async () => {});
    replace(linq, 'sendMessage', async (...args) => {
      sent.push(args);
      return { message: { id: `sent-${sent.length}`, service, delivery_status: 'queued' } };
    });
    replace(linq, 'getContactCard', async phone => ({ first_name: 'Claude', last_name: 'Sullivan', phone_number: phone, is_active: true }));
    replace(linq, 'uploadContactVCard', async () => ({ attachmentId: 'vcf', downloadUrl: 'https://example.com/contact.vcf' }));
    replace(conversation, 'getConversation', async () => []);
    replace(conversation, 'getUserProfile', async () => null);
    replace(conversation, 'addMessage', async () => {});
    replace(usage, 'consumeMessageQuota', async () => ({ allowed: true }));
    replace(contactState, 'getContactShareStatus', async () => 'not_shared');
    replace(contactState, 'claimContactShare', async () => true);
    replace(contactState, 'completeContactShare', async (...args) => { remembered.push(args); });
    replace(Anthropic.Messages.prototype, 'create', async options => {
      const tool = options.tools.find(tool => tool.name === 'send_contact_card');
      assert.equal(tool.input_schema.properties.message, undefined);
      return { content: [
        { type: 'text', text: `hey! whats good---${intro}` },
        // Reproduce the actual bug: the exact same sentence in normal text
        // and an old-style tool argument. The argument must never be sent.
        { type: 'tool_use', id: 'tool', name: 'send_contact_card', input: { requested_by_user: service === 'SMS', message: intro } },
      ] };
    });
    require('../dist/index.js');
    assert.equal(typeof webhook, 'function');
    for (service of ['RCS', 'SMS']) {
      sent.length = 0;
      const res = { status: () => res, json: () => res };
      await webhook({ body: { event_type: 'message.received', data: {
        chat_id: 'chat', from: '+14155550200', recipient_phone: '+14155550100', service,
        is_from_me: false, message: { id: `incoming-${service}`, parts: [{ type: 'text', value: service === 'RCS' ? 'hey' : 'send your contact' }] },
      } } }, res);
      assert.equal(sent.length, 3, 'exactly greeting, one introduction, and one contact');
      assert.equal(sent.filter(args => args[1] === intro).length, 1);
      assert.equal(sent[0][1], 'hey! whats good');
      if (service === 'RCS') assert.deepEqual(sent[2][4], [{ attachment_id: 'vcf' }]);
      else assert.equal(sent[2][1], 'https://example.com/contact.vcf');
    }
    assert.equal(remembered.length, 2, 'successful sharing is still remembered');
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});
