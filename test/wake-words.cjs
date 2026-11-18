const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ANTHROPIC_API_KEY = 'test';
process.env.OPENAI_API_KEY = 'test';
const Anthropic = require('@anthropic-ai/sdk');
const conversation = require('../dist/state/conversation.js');
const { wakeWords, loadPersona } = require('../dist/persona.js');
const { groupChatClassifierPrompt, getGroupChatAction } = require('../dist/claude/client.js');

const CLAUDE_TYPOS = ['cluade', 'cloude', 'cladue', 'claud', 'ckaude'];
const wordsLine = prompt => prompt.split('\n').find(line => line.includes('They used any of these words'));

test('Claude wakes on its name, its typos and the generic words', () => {
  assert.deepEqual(wakeWords('Claude'), ['claude', ...CLAUDE_TYPOS, 'ai', 'bot', 'assistant']);
  assert.deepEqual(loadPersona({}).wakeWords, wakeWords('Claude'));
  const prompt = groupChatClassifierPrompt(loadPersona({}));
  assert.match(prompt, /^You classify how an AI assistant "Claude" should handle/);
  for (const typo of CLAUDE_TYPOS) assert.ok(wordsLine(prompt).includes(`"${typo}"`), typo);
  assert.match(prompt, /MISSPELLING TOLERANCE/);
  assert.match(prompt, /"hey claude what's the weather" -> respond/);
  assert.doesNotMatch(prompt, /sullivan|linq/i);
});

test('Linq Sullivan wakes on linq and sullivan with no Claude typos; linq has its own rule, and link is not a wake word', () => {
  const words = wakeWords('Linq Sullivan');
  assert.deepEqual(words, ['linq', 'sullivan', 'ai', 'bot', 'assistant']);
  const prompt = groupChatClassifierPrompt({ name: 'Linq Sullivan', wakeWords: words });
  assert.equal(wordsLine(prompt), '  * They used any of these words, in any capitalization: "sullivan", "ai", "bot", "assistant"');
  assert.match(prompt, /Respond to "linq" when they're talking to Linq Sullivan \("linq what can you do\?"\), not when people mention Linq to each other/);
  assert.match(prompt, /"mike did you sign up for the linq sandbox yet\?" -> ignore/);
  assert.doesNotMatch(prompt, /claude|cluade|MISSPELLING/i);
  assert.match(prompt, /"link" is an ordinary word, not "linq"/);
  assert.match(prompt, /"mike can you send me the link\?" -> ignore/);
  assert.match(prompt, /"hey linq what's the weather" -> respond/);
});

test('name words need 3 or more letters; Claude typos only when the name contains Claude', () => {
  assert.deepEqual(wakeWords('Jo Ada-Bot'), ['ada', 'bot', 'ai', 'assistant']);
  assert.deepEqual(wakeWords('Claude Sullivan'), ['claude', 'sullivan', ...CLAUDE_TYPOS, 'ai', 'bot', 'assistant']);
  assert.deepEqual(wakeWords('Link'), ['ai', 'bot', 'assistant']);
  assert.doesNotMatch(groupChatClassifierPrompt({ name: 'Ada', wakeWords: wakeWords('Ada') }), /claude|cluade|"link"/i);
});

test('AGENT_WAKE_WORDS adds words, trimmed, lowercased and stripped of surrounding punctuation, and never adds link', () => {
  const persona = loadPersona({ AGENT_NAME: 'Linq Sullivan', AGENT_WAKE_WORDS: ' Sully! , "hey LS",,link., Linq ' });
  assert.deepEqual(persona.wakeWords, ['linq', 'sullivan', 'sully', 'hey ls', 'ai', 'bot', 'assistant']);
  assert.deepEqual(loadPersona({ AGENT_WAKE_WORDS: 'Sonnet' }).wakeWords, ['claude', 'sonnet', ...CLAUDE_TYPOS, 'ai', 'bot', 'assistant']);
  assert.ok(wordsLine(groupChatClassifierPrompt(persona)).includes('"sully", "hey ls"'));
});

test('classifier labels the agent\'s own messages with its name', async () => {
  const originalCreate = Anthropic.Messages.prototype.create;
  const originalGet = conversation.getConversation;
  let request;
  conversation.getConversation = async () => [
    { role: 'user', content: 'hey sullivan', handle: '+14155550200' },
    { role: 'assistant', content: 'Hi! What can I help with?' },
  ];
  Anthropic.Messages.prototype.create = async options => {
    request = options;
    return { content: [{ type: 'text', text: 'respond' }] };
  };
  try {
    const persona = loadPersona({ AGENT_NAME: 'Linq Sullivan', AGENT_PERSONA: 'You are Linq Sullivan.' });
    const result = await getGroupChatAction('thanks linq', '+14155550200', 'chat', persona);
    assert.equal(result.action, 'respond');
    const content = request.messages[0].content;
    assert.ok(content.includes('+14155550200: hey sullivan\nLinq Sullivan: Hi! What can I help with?'));
    assert.ok(content.endsWith('How should Linq Sullivan handle this?'));
    assert.equal(content.includes('Claude:'), false);
    assert.equal(request.system, groupChatClassifierPrompt(persona));
  } finally {
    Anthropic.Messages.prototype.create = originalCreate;
    conversation.getConversation = originalGet;
  }
});
