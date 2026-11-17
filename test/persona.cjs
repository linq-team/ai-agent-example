const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.env.ANTHROPIC_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
// chat() reads the persona from the environment
process.env.AGENT_NAME = 'Ada';
process.env.AGENT_PERSONA = 'You are Ada, a test persona.';
delete process.env.AGENT_PERSONA_FILE;
const Anthropic = require('@anthropic-ai/sdk');
const conversation = require('../dist/state/conversation.js');
const { loadPersona, defaultPersona } = require('../dist/persona.js');
const { chat, buildSystemPrompt } = require('../dist/claude/client.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
let tempFiles = 0;
function tempFile(contents) {
  const file = path.join(tempDir, `persona-${++tempFiles}.md`);
  fs.writeFileSync(file, contents);
  return file;
}

test('default persona: Claude, generic identity, Linq links and casual style', () => {
  const persona = loadPersona({});
  assert.equal(persona.name, 'Claude');
  assert.equal(persona.source, 'default');
  assert.match(persona.text, /^You are Claude, an AI agent people text, built on the Linq API/);
  assert.match(persona.text, /powered by Claude, Anthropic's model - be upfront about that if asked/);
  for (const link of ['linqapp.com', 'https://dashboard.linqapp.com/sandbox-signup/', 'https://github.com/linq-team/ai-agent-example']) {
    assert.ok(persona.text.includes(link), link);
  }
  assert.match(persona.text, /## Response Style/);
  assert.equal(loadPersona({ AGENT_NAME: ' Linq Sullivan ' }).text, defaultPersona('Linq Sullivan'));
  assert.match(defaultPersona('Linq Sullivan'), /^You are Linq Sullivan, an AI agent/);
});

test('default persona no longer credits a Linq staff member', () => {
  assert.equal(defaultPersona('Claude').includes('Patrick Sullivan (CTO'), false);
  assert.equal(defaultPersona('Claude').includes('Sullivan'), false);
});

test('inline and file personas replace the default', () => {
  const inline = loadPersona({ AGENT_NAME: 'Ada', AGENT_PERSONA: '  You are Ada.\n' });
  assert.deepEqual([inline.name, inline.text, inline.source], ['Ada', 'You are Ada.', 'AGENT_PERSONA']);
  const file = tempFile('\nYou are Ada, from a file.\n\nKeep it short.\n');
  const fromFile = loadPersona({ AGENT_PERSONA_FILE: file });
  assert.equal(fromFile.text, 'You are Ada, from a file.\n\nKeep it short.');
  assert.equal(fromFile.source, `AGENT_PERSONA_FILE (${file})`);
  assert.equal(fromFile.name, 'Claude');
});

test('unusable persona settings are clear errors', () => {
  const file = tempFile('You are Ada.');
  assert.throws(() => loadPersona({ AGENT_PERSONA: 'You are Ada.', AGENT_PERSONA_FILE: file }), /Set AGENT_PERSONA or AGENT_PERSONA_FILE, not both/);
  assert.throws(() => loadPersona({ AGENT_PERSONA: ' \n ' }), /AGENT_PERSONA is set but empty/);
  assert.throws(() => loadPersona({ AGENT_PERSONA_FILE: tempFile('  \n') }), /AGENT_PERSONA_FILE is empty/);
  assert.throws(() => loadPersona({ AGENT_PERSONA_FILE: '' }), /AGENT_PERSONA_FILE is set but empty/);
  const missing = path.join(os.tmpdir(), 'no-such-dir', 'persona.md');
  assert.throws(() => loadPersona({ AGENT_PERSONA_FILE: missing }), err => err.message.startsWith(`AGENT_PERSONA_FILE could not be read (${missing}): ENOENT`));
  assert.throws(() => loadPersona({ AGENT_PERSONA_FILE: path.dirname(file) }), /AGENT_PERSONA_FILE could not be read/);
  assert.throws(() => loadPersona({ AGENT_NAME: '  ' }), /AGENT_NAME is set but empty/);
});

test('the app refuses to start with a bad persona setting', () => {
  const run = spawnSync(process.execPath, ['-e', "require('./dist/index.js')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', AGENT_PERSONA: 'x', AGENT_PERSONA_FILE: 'persona.md' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\[persona\] Set AGENT_PERSONA or AGENT_PERSONA_FILE, not both\./);
});

test('system prompt is the chosen persona followed by the mechanics', () => {
  const persona = loadPersona({ AGENT_NAME: 'Ada', AGENT_PERSONA: 'You are Ada, a test persona.' });
  const prompt = buildSystemPrompt({
    isGroupChat: true, participantNames: ['+14155550100', '+14155550200', '+14155550201'], chatName: 'Team',
    senderHandle: '+14155550200', service: 'iMessage', contactShareStatus: 'shared',
  }, persona);
  assert.ok(prompt.startsWith('You are Ada, a test persona.\n\n'));
  for (const section of ['## How your replies are sent', '## Demo Capabilities', '## Commands', '/forget me', '## This is a limited demo',
    '## Reactions', '## Message Effects', "## About the person you're talking to", '## Group Chat Context', '## Messaging Platform',
    '## Text Decorations (iMessage only)', '## Sharing your contact']) {
    assert.ok(prompt.includes(section), section);
  }
  assert.equal(prompt.includes('## Response Style'), false);
  assert.equal(prompt.includes('Anthropic'), false);

  const fallback = buildSystemPrompt(undefined, loadPersona({}));
  assert.ok(fallback.startsWith(defaultPersona('Claude')));
  assert.ok(fallback.includes('## Reactions'));
});

test('chat() sends the persona from the environment', async () => {
  const originalCreate = Anthropic.Messages.prototype.create;
  const originalGet = conversation.getConversation;
  const originalAdd = conversation.addMessage;
  let system;
  conversation.getConversation = async () => [];
  conversation.addMessage = async () => {};
  Anthropic.Messages.prototype.create = async options => {
    system = options.system;
    return { content: [{ type: 'text', text: 'hi' }] };
  };
  try {
    await chat('chat', 'hello', [], [], { isGroupChat: false, participantNames: [], chatName: null, service: 'SMS' });
    assert.ok(system.startsWith('You are Ada, a test persona.\n\n## How your replies are sent'));
  } finally {
    Anthropic.Messages.prototype.create = originalCreate;
    conversation.getConversation = originalGet;
    conversation.addMessage = originalAdd;
  }
});
