const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.LINQ_API_TOKEN = 'test-token';
const { createVCard, detectContactPhoto } = require('../dist/contact/vcard.js');
const { createContactSharer } = require('../dist/contact/sharing.js');
const { uploadContactVCard, sendMessage } = require('../dist/linq/client.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9V8AAAAASUVORK5CYII=', 'base64');
const contact = { first_name: 'Claude', last_name: 'Sullivan', phone_number: '+14155550100', is_active: true, image_url: 'https://example.com/photo.png' };

test('VCF preserves escaped Unicode names, E.164 number, and embedded photo', () => {
  const name = '👋é'.repeat(30) + ',;\\\r\nEND:VCARD';
  const bytes = createVCard({ ...contact, first_name: name }, detectContactPhoto(png));
  const physicalLines = bytes.toString().split('\r\n');
  for (const line of physicalLines) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(bytes.toString().includes('\ufffd'), false);
  const unfolded = bytes.toString().replace(/\r\n /g, '');
  assert.ok(unfolded.includes('TEL;TYPE=CELL:+14155550100\r\n'));
  assert.ok(unfolded.includes('\\,\\;\\\\\\nEND:VCARD'));
  assert.equal(unfolded.split('\r\n').filter(line => line === 'END:VCARD').length, 1);
  const photo = unfolded.match(/PHOTO;ENCODING=b;TYPE=PNG:([^\r]+)/)[1];
  assert.deepEqual(Buffer.from(photo, 'base64'), png);
  assert.ok(unfolded.endsWith('END:VCARD\r\n'));
  assert.throws(() => createVCard({ ...contact, phone_number: 'bad\r\nFN:injected' }), /E.164/);
  assert.throws(() => detectContactPhoto(Buffer.from('<html>error</html>')), /photo/);
});

function fixture(overrides = {}, records = new Map()) {
  const calls = { lookups: [], uploads: [], sends: [] };
  const share = createContactSharer({
    getContactCard: async phone => { calls.lookups.push(phone); return { ...contact, phone_number: phone }; },
    downloadPhoto: async () => png,
    uploadContactVCard: async bytes => { calls.uploads.push(bytes); return { attachmentId: 'attachment', downloadUrl: 'https://example.com/contact.vcf' }; },
    sendMessage: async (...args) => { calls.sends.push(args); return { message: { id: 'sent-message', delivery_status: 'queued' } }; },
    getContactShareStatus: async (bot, person) => records.get(bot + person)?.shared ? 'shared' : 'not_shared',
    claimContactShare: async (bot, person, request, owner, requested) => {
      const record = records.get(bot + person) || {};
      if (record.owner || record.request === request || (!requested && record.shared)) return false;
      records.set(bot + person, { ...record, owner }); return true;
    },
    completeContactShare: async (bot, person, request) => { records.set(bot + person, { shared: true, request }); },
    releaseContactShare: async (bot, person) => { const record = records.get(bot + person); if (record) delete record.owner; },
    ...overrides,
  });
  return { calls, share, records };
}
const request = {
  chatId: 'chat', botNumber: contact.phone_number, person: '+14155550200',
  incomingMessageId: 'incoming', service: 'RCS', isGroupChat: false,
  requestedByUser: false, message: 'btw here’s my contact if you wanna save me',
};

test('proactive RCS tool remembers a person across chats and process restarts, and deduplicates concurrent calls', async () => {
  const { share, calls, records } = fixture();
  const results = await Promise.all([share(request), share(request)]);
  assert.equal(results.filter(r => r.status === 'sent').length, 1);
  assert.equal(calls.sends.length, 2); // intro, then file
  const restarted = fixture({}, records);
  assert.equal((await restarted.share({ ...request, chatId: 'new-chat', incomingMessageId: 'new-event' })).status, 'skipped');
  assert.equal(restarted.calls.uploads.length, 0);
  await share({ ...request, person: '+14155550201' });
  assert.equal(calls.uploads.length, 1); // same bot contact reused for another person
  await share({ ...request, botNumber: '+14155550101' });
  assert.equal(calls.uploads.length, 2);
});

test('explicit requests work on all services and can resend; repeated webhook cannot resend', async () => {
  for (const service of ['iMessage', 'RCS', 'SMS']) {
    const { share, calls } = fixture();
    const explicit = { ...request, service, requestedByUser: true };
    assert.equal((await share(explicit)).status, 'sent');
    assert.equal((await share(explicit)).status, 'skipped');
    assert.equal((await share({ ...explicit, incomingMessageId: 'resend' })).status, 'sent');
    assert.equal(calls.sends.length, 4);
    if (service === 'SMS') {
      assert.equal(calls.sends[1][1], 'https://example.com/contact.vcf');
      assert.equal(calls.sends[1][4], undefined);
    } else assert.deepEqual(calls.sends[1][4], [{ attachment_id: 'attachment' }]);
    assert.notEqual(calls.sends[1][6], calls.sends[3][6]);
  }
});

test('proactive tool never sends in iMessage, SMS, group chats, or unknown history', async () => {
  const { share, calls } = fixture();
  for (const service of ['iMessage', 'SMS', undefined]) assert.equal((await share({ ...request, service })).status, 'skipped');
  assert.equal((await share({ ...request, isGroupChat: true })).status, 'skipped');
  const unknown = fixture({ getContactShareStatus: async () => 'unknown' });
  assert.equal((await unknown.share(request)).status, 'skipped');
  assert.equal(calls.sends.length, 0);
});

test('failed sends remain retryable with stable idempotency keys; failed sends are not remembered', async () => {
  let attempts = 0;
  const keys = [];
  const { share, records } = fixture({ sendMessage: async (...args) => {
    keys.push(args[6]);
    if (++attempts === 2) throw new Error('temporary failure');
    return { message: { id: 'sent', delivery_status: 'queued' } };
  } });
  assert.equal((await share(request)).status, 'failed');
  assert.equal(records.get(request.botNumber + request.person).shared, undefined);
  assert.equal((await share(request)).status, 'sent');
  assert.equal(keys[0], keys[2]); assert.equal(keys[1], keys[3]);
  const missing = fixture({ getContactCard: async () => undefined });
  assert.equal((await missing.share(request)).status, 'failed');
  assert.equal(missing.calls.sends.length, 0);
  const failedPhoto = fixture({ downloadPhoto: async () => { throw new Error('bad photo'); } });
  assert.equal((await failedPhoto.share(request)).status, 'failed');
  assert.equal(failedPhoto.calls.uploads.length, 0);
});

test('proactive introductions can be disabled without disabling explicit tool requests', async () => {
  const previous = process.env.RCS_CONTACT_CARD_ENABLED;
  process.env.RCS_CONTACT_CARD_ENABLED = 'false';
  try {
    const { share, calls } = fixture();
    assert.equal((await share(request)).status, 'skipped');
    assert.equal((await share({ ...request, requestedByUser: true })).status, 'sent');
    assert.equal(calls.sends.length, 2);
  } finally {
    if (previous === undefined) delete process.env.RCS_CONTACT_CARD_ENABLED;
    else process.env.RCS_CONTACT_CARD_ENABLED = previous;
  }
});

test('webhook passes the bot recipient number separately from the sender', async () => {
  const { createWebhookHandler } = require('../dist/webhook/handler.js');
  let received;
  const handler = createWebhookHandler(async (...args) => { received = args; });
  const res = { status: () => res, json: () => res };
  await handler({ body: { event_type: 'message.received', data: {
    chat_id: 'chat', from: '+14155550200', recipient_phone: '+14155550100',
    is_from_me: false, service: 'RCS', message: { id: 'incoming', parts: [{ type: 'text', value: 'hello' }] },
  } } }, res);
  assert.equal(received[1], '+14155550200');
  assert.equal(received[8], 'RCS');
  assert.equal(received[9], '+14155550100');
});

test('upload uses signed headers and exact VCF bytes, then sends attachment_id without a routing override', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const bytes = createVCard(contact, detectContactPhoto(png));
  global.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return { ok: true, json: async () => ({ attachment_id: 'upload-id', upload_url: 'https://storage.example/upload', download_url: 'https://storage.example/contact.vcf', required_headers: { 'Content-Type': 'text/vcard', 'x-upload-test': 'signed' } }) };
    if (calls.length === 2) return { ok: true };
    return { ok: true, json: async () => ({ message: { id: 'message' } }) };
  };
  try {
    const uploaded = await uploadContactVCard(bytes);
    await sendMessage('chat', '', undefined, undefined, [{ attachment_id: uploaded.attachmentId }]);
    assert.deepEqual(JSON.parse(calls[0].body), { filename: 'contact.vcf', content_type: 'text/vcard', size_bytes: bytes.length });
    assert.deepEqual(calls[1].headers, { 'Content-Type': 'text/vcard', 'x-upload-test': 'signed' });
    assert.deepEqual(Buffer.from(calls[1].body), bytes);
    assert.deepEqual(JSON.parse(calls[2].body), { message: { parts: [{ type: 'media', attachment_id: 'upload-id' }] } });
  } finally { global.fetch = originalFetch; }
});
