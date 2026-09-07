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

function fixture(overrides = {}) {
  const calls = { lookups: [], uploads: [], sends: [], native: [] };
  const share = createContactSharer({
    getContactCard: async phone => { calls.lookups.push(phone); return { ...contact, phone_number: phone }; },
    downloadPhoto: async () => png,
    uploadContactVCard: async bytes => { calls.uploads.push(bytes); return 'attachment'; },
    sendMessage: async (...args) => { calls.sends.push(args); return {}; },
    shareContactCard: async id => { calls.native.push(id); },
    ...overrides,
  });
  return { calls, share };
}
const request = { chatId: 'chat', botNumber: contact.phone_number, service: 'RCS', shareNative: true };

test('RCS sends once per chat including concurrent messages, reusing the attachment for another chat', async () => {
  const { share, calls } = fixture();
  await Promise.all([share(request), share(request)]);
  await share(request);
  await share({ ...request, chatId: 'second' });
  assert.equal(calls.sends.length, 2);
  assert.equal(calls.uploads.length, 1);
  assert.deepEqual(calls.sends[0], ['chat', '', undefined, undefined, [{ attachment_id: 'attachment' }]]);
  assert.equal(calls.native.length, 0);
  await share({ ...request, botNumber: '+14155550101' });
  assert.equal(calls.uploads.length, 2);
  assert.ok(calls.uploads[1].toString().includes('+14155550101'));
});

test('iMessage uses native sharing; SMS/unknown never get a VCF; switching to RCS works', async () => {
  const { share, calls } = fixture();
  await share({ ...request, service: 'iMessage' });
  await share({ ...request, service: 'iMessage', shareNative: false });
  await share({ ...request, service: 'SMS' });
  await share({ ...request, service: undefined });
  assert.deepEqual(calls.native, ['chat']);
  assert.equal(calls.uploads.length, 0);
  await share(request);
  assert.equal(calls.sends.length, 1);
});

test('failed sends remain retryable and contact failures never reject the reply flow', async () => {
  let attempts = 0;
  const { share, calls } = fixture({ sendMessage: async () => { if (++attempts === 1) throw new Error('temporary failure'); } });
  await assert.doesNotReject(share(request));
  await share(request);
  await share(request);
  assert.equal(attempts, 2);
  assert.equal(calls.uploads.length, 1);
  const missing = fixture({ getContactCard: async () => undefined });
  await assert.doesNotReject(missing.share(request));
  assert.equal(missing.calls.sends.length, 0);
  const failedPhoto = fixture({ downloadPhoto: async () => { throw new Error('bad photo'); } });
  await assert.doesNotReject(failedPhoto.share(request));
  assert.equal(failedPhoto.calls.uploads.length, 0);
});

test('VCF sharing can be disabled without disabling native iMessage sharing', async () => {
  const previous = process.env.RCS_CONTACT_CARD_ENABLED;
  process.env.RCS_CONTACT_CARD_ENABLED = 'false';
  try {
    const { share, calls } = fixture();
    await share(request);
    await share({ ...request, service: 'iMessage' });
    assert.equal(calls.uploads.length, 0);
    assert.deepEqual(calls.native, ['chat']);
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
    if (calls.length === 1) return { ok: true, json: async () => ({ attachment_id: 'upload-id', upload_url: 'https://storage.example/upload', required_headers: { 'Content-Type': 'text/vcard', 'x-upload-test': 'signed' } }) };
    if (calls.length === 2) return { ok: true };
    return { ok: true, json: async () => ({ message: { id: 'message' } }) };
  };
  try {
    const id = await uploadContactVCard(bytes);
    await sendMessage('chat', '', undefined, undefined, [{ attachment_id: id }]);
    assert.deepEqual(JSON.parse(calls[0].body), { filename: 'contact.vcf', content_type: 'text/vcard', size_bytes: bytes.length });
    assert.deepEqual(calls[1].headers, { 'Content-Type': 'text/vcard', 'x-upload-test': 'signed' });
    assert.deepEqual(Buffer.from(calls[1].body), bytes);
    assert.deepEqual(JSON.parse(calls[2].body), { message: { parts: [{ type: 'media', attachment_id: 'upload-id' }] } });
  } finally { global.fetch = originalFetch; }
});
