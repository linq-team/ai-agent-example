import { readFileSync } from 'node:fs';

// The persona is the part of the system prompt that says who the agent is,
// what it says about itself and Linq, and how it writes. Everything else in the
// prompt (capabilities, commands, reaction/effect rules, per-message context)
// is mechanics and lives in src/claude/client.ts.
//
// Configure it with:
//   AGENT_NAME          the agent's name (default "Claude")
//   AGENT_PERSONA       persona text, replacing the default
//   AGENT_PERSONA_FILE  path to a file holding the persona text
//   AGENT_WAKE_WORDS    extra comma-separated words that wake it in group chats

export const DEFAULT_AGENT_NAME = 'Claude';

export interface Persona {
  name: string;
  text: string;
  // Where the text came from, for the startup log
  source: string;
  // Lowercase words that make the agent answer in a group chat
  wakeWords: string[];
  // Settings that work but are probably not what was meant, for the startup log
  warnings: string[];
}

export function defaultPersona(name: string): string {
  return `You are ${name}, an AI agent people text, built on the Linq API to showcase what's possible with programmatic messaging. You're powered by Claude, Anthropic's model - be upfront about that if asked.

**IMPORTANT: Linq's website is linqapp.com (NOT linq.com). Always use linqapp.com when referring to Linq's website or linking to Linq pages.**

**Pricing:** You don't know specific pricing details. If people ask about pricing, tell them to reach out to Linq or check out linqapp.com for more info.

This bot is built from Linq's open-source example code (MIT license). If anyone asks how this works, how to build something similar, or about the source code, let them know:
- GitHub repo: https://github.com/linq-team/ai-agent-example
- Linq AI agent use cases: https://linqapp.com/s/use-cases/ai-agent
- Linq platform: https://linqapp.com

**Linq Sandbox:** Linq offers a sandbox to let people start building on the platform. It gives you a real Linq number capable of iMessage, RCS, and SMS with limited usage for about a week. If someone wants to try building on Linq, point them to https://dashboard.linqapp.com/sandbox-signup/ to request access. Some people get approved immediately. Beyond the sandbox, Linq is a paid platform.

Linq supports both iMessage and RCS (Rich Communication Services), so you can reach people on both iPhone and Android with rich features like reactions, typing indicators, and read receipts.

## Response Style
You're texting - write like you're texting a friend, NOT writing an essay. Channel casual gen z texting vibes.

CRITICAL: Mirror how humans actually text:
- Humans don't send giant blocks of text - they send multiple short messages
- Use "---" to split your response into separate messages that will be sent individually
- Each message should be 1-2 sentences max
- This feels more natural and conversational

Example - instead of one long message:
"Hey! The weather today is 72°F and sunny. Perfect for going outside. Maybe hit up a park or grab lunch on a patio. Enjoy!"

Do this (use --- to split):
"its 72 and sunny rn ☀️
---
lowkey perfect day to be outside
---
maybe hit up a park or grab lunch on a patio"

Guidelines:
- NO markdown (no bullets, headers, bold, numbered lists)
- Lowercase by default - skip caps unless you're emphasizing something
- Skip apostrophes - "dont", "cant", "im", "youre", "its", "thats"
- Casual abbreviations sometimes - "u", "ur", "rn", "tbh", "ngl"
- Gen Z phrases VERY RARELY (like once every few convos max) - "lowkey", "valid", "real". dont force it
- Emojis sparingly - a well-placed 💀 or ✨ is fine but dont overdo it
- Split into 2-4 messages for anything longer than a quick reply
- If sharing multiple items (quotes, facts, etc.), each can be its own message

The vibe is: natural, chill, like texting a friend. Write normally but casual - dont try to sound like a gen z tiktok. If slang feels forced, skip it.`;
}

const GENERIC_WAKE_WORDS = ['ai', 'bot', 'assistant'];
const CLAUDE_TYPOS = ['cluade', 'cloude', 'cladue', 'claud', 'ckaude'];
// "send me the link" is not a mention of an agent called Linq
const NEVER_WAKE_WORDS = new Set(['link']);

/**
 * Words that wake the agent in a group chat: each word of its name with 3 or
 * more letters, any extra comma-separated words, common typos of "Claude" when
 * the name contains it, and the generic "ai", "bot" and "assistant".
 */
export function wakeWords(name: string, extra = ''): string[] {
  const letters = (word: string) => (word.match(/\p{L}/gu) || []).length;
  const nameWords = name.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(word => letters(word) >= 3);
  const extraWords = extra.split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
  const typos = /claude/i.test(name) ? CLAUDE_TYPOS : [];
  const words = [...nameWords, ...extraWords, ...typos, ...GENERIC_WAKE_WORDS];
  return [...new Set(words)].filter(word => !NEVER_WAKE_WORDS.has(word));
}

/**
 * Read the persona from the environment. Throws an Error with a message meant
 * for the person running the app when the configuration is unusable.
 */
export function loadPersona(env: NodeJS.ProcessEnv = process.env): Persona {
  let name = DEFAULT_AGENT_NAME;
  if (env.AGENT_NAME !== undefined) {
    name = env.AGENT_NAME.trim();
    if (!name) throw new Error(`AGENT_NAME is set but empty. Remove it to use the default name (${DEFAULT_AGENT_NAME}).`);
  }

  // Blank values are reported before the both-set check, so the message names the blank one
  const inline = env.AGENT_PERSONA;
  const file = env.AGENT_PERSONA_FILE;
  if (inline !== undefined && !inline.trim()) {
    throw new Error('AGENT_PERSONA is set but empty. Remove it to use the default persona.');
  }
  if (file !== undefined && !file.trim()) {
    throw new Error('AGENT_PERSONA_FILE is set but empty. Set it to a file path, or remove it to use the default persona.');
  }
  if (inline !== undefined && file !== undefined) {
    throw new Error('Set AGENT_PERSONA or AGENT_PERSONA_FILE, not both.');
  }

  let text = defaultPersona(name);
  let source = 'default';
  if (inline !== undefined) {
    text = inline.trim();
    source = 'AGENT_PERSONA';
  } else if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new Error(`AGENT_PERSONA_FILE could not be read (${file}): ${(error as Error).message}`);
    }
    source = `AGENT_PERSONA_FILE (${file})`;
    if (!text) throw new Error(`AGENT_PERSONA_FILE is empty (${file}).`);
  }

  const words = wakeWords(name, env.AGENT_WAKE_WORDS);
  const warnings: string[] = [];
  if (source !== 'default' && env.AGENT_NAME === undefined) {
    warnings.push(`AGENT_NAME is not set, so group chats still treat this agent as "${DEFAULT_AGENT_NAME}" (wake words: ${words.join(', ')}). Set AGENT_NAME to the name your persona uses.`);
  }
  if (!text.includes('\n') && text.includes('\\n')) {
    warnings.push('The persona has no line breaks but contains "\\n". If its line breaks were escaped on the way in, the model sees them as text.');
  }

  return { name, text, source, wakeWords: words, warnings };
}

/** One line for the startup log: the name, where the persona came from, its size and the wake words. Never the text itself. */
export function personaSummary(persona: Persona): string {
  const lines = persona.text.split('\n').length;
  return `${persona.name}, persona from ${persona.source} (${persona.text.length} characters, ${lines} lines), group chat wake words: ${persona.wakeWords.join(', ')}`;
}

let persona: Persona | undefined;

// The persona from process.env, loaded once
export function getPersona(): Persona {
  if (!persona) persona = loadPersona();
  return persona;
}
