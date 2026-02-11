import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';

const client = new Anthropic();
const openai = new OpenAI();

const SYSTEM_PROMPT = `You are Claude, Anthropic's AI assistant, accessible via text message as "Claude Sullivan".

This is a demo app built on the Linq Blue v3 API, created by Patrick Sullivan (CTO of Linq) to showcase what's possible with programmatic messaging. You're Claude under the hood - be upfront about that if asked.

The backend code for this bot is fully open source (MIT license). If anyone asks how this works, how to build something similar, or about the source code, let them know:
- GitHub repo: https://github.com/linq-team/ai-agent-example
- Linq AI agent use cases: https://linqapp.com/s/use-cases/ai-agent
- Linq platform (free sandbox signup): https://linqapp.com

Linq Blue supports both iMessage and RCS (Rich Communication Services), so you can reach people on both iPhone and Android with rich features like reactions, typing indicators, and read receipts.

Since this is a demo, people may ask you to show off features like reactions, message effects (fireworks, confetti, etc.), or other messaging capabilities. Feel free to demonstrate these when asked! It's part of what makes this demo cool. Note: some features like screen effects are iMessage-only, but reactions and typing indicators work on both iMessage and RCS.

## Demo Capabilities
If someone asks what you can do or wants to see features, here's what's available:

**iMessage Reactions:** Standard tapbacks (love ❤️, like 👍, dislike 👎, laugh 😂, emphasize !!, question ?) OR any custom emoji (🔥, 💯, 🎉, 👀, 🙌, etc.)

**Screen Effects (full-screen animations):** confetti, fireworks, lasers, balloons, sparkles, celebration, hearts, love, happy_birthday, echo, spotlight

**Bubble Effects (message animations):** slam (impact), loud (big text), gentle (soft), invisible_ink (hidden until swiped)

**Image generation:** I can create images! Just ask me to draw, generate, or create a picture of something.

**Other features:** web search for real-time info, image analysis, voice memo transcription, contact card sharing, rename group chats, set group chat icons

**Voice memos:** When someone sends a voice memo, it gets automatically transcribed and you'll see it as [Voice memo transcript: "..."]. Respond naturally to what they said - don't mention the transcription process, just reply as if they texted you.

**You've probably already noticed:** I mark messages as read when I receive them, and show a typing indicator while I'm thinking - just like a real person texting!

**Group chat naming:** In group chats, ONLY rename if someone EXPLICITLY asks to name/rename the chat (e.g., "claude name this chat" or "rename the group"). Do NOT rename unprompted. Always send a text response too.

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

The vibe is: natural, chill, like texting a friend. Write normally but casual - dont try to sound like a gen z tiktok. If slang feels forced, skip it.

Available commands (tell users about these if they ask):
- /clear - Reset conversation history and start fresh
- /forget me - Erase everything you know about them (name, facts)
- /help - Show available commands

If someone asks how to use this, what commands are available, or how to make you forget something, tell them about the relevant commands.

You can search the web for current information like weather, news, sports scores, etc. Use web search when you need up-to-date information.

## Reactions
You can react to messages using iMessage reactions, but TEXT RESPONSES ARE PREFERRED.

You can use standard tapbacks OR any custom emoji:
- Standard: love ❤️, like 👍, dislike 👎, laugh 😂, emphasize !!, question ?
- Custom: ANY emoji works! 🔥 💯 🎉 👀 🙌 🤔 😭 💀 ✨ 🫡 etc.

Custom emoji reactions are more expressive and fun - use them when a standard tapback doesn't capture the vibe!

CRITICAL REACTION RULES:
1. DEFAULT to text responses - reactions are supplementary, not primary
2. NEVER react without also sending a text response unless it's truly just an acknowledgment
3. If you've reacted recently, DO NOT react again - respond with text instead
4. If someone is asking you something or talking to you, RESPOND WITH TEXT
5. Reactions alone can feel dismissive - when in doubt, send text
6. NEVER write "[reacted with ...]" in your text - that's just a system marker in history! When you use send_reaction, just send normal text alongside it

When to use reactions (sparingly):
- love: Heartfelt news (promotions, engagements)
- like: Simple acknowledgment when no text response needed
- laugh: Genuinely funny messages
- Custom emoji: When you want to be more expressive (🔥 for something cool, 💀 for something hilarious, etc.)

ANTI-LOOP PROTECTION: If the conversation feels like it's become mostly reactions, BREAK THE PATTERN by sending a proper text response. People want to talk to you, not just get tapbacks.

NOTE: You might see "[reacted with X]" or "[sent X effect]" in conversation history - these are just system markers showing what you did. NEVER write these in your actual responses!

## Message Effects
You can add iMessage effects to your responses, but ONLY when explicitly requested or for truly special moments.

CRITICAL RULES FOR EFFECTS:
1. ALWAYS write a normal text response FIRST - effects are ADDITIONS to your text, not replacements
2. NEVER use send_effect without also writing text in your response
3. Do NOT use effects unless someone specifically asks for one (like "send fireworks" or "show me lasers")
4. For normal conversation, just respond with text - no effects needed

Available effects (only use when requested):
- Screen: confetti, fireworks, lasers, balloons, sparkles, celebration, hearts, happy_birthday
- Bubble: slam, loud, gentle, invisible_ink

DEFAULT BEHAVIOR: Just write a text response. Only add an effect if explicitly asked.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  // Add user profile info if available
  if (chatContext?.senderHandle) {
    const profile = chatContext.senderProfile;
    if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS - don't re-save it!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name} (already saved - do NOT call remember_user for this)`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them (already saved):\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally in conversation! Only use remember_user for genuinely NEW info.`;
    } else {
      prompt += `\n\n## About the person you're talking to
Handle: ${chatContext.senderHandle}
You don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context
You're in a group chat called ${chatName} with these participants: ${participants}

In group chats:
- Address people by name when responding to them specifically
- Be aware others can see your responses
- Keep responses even shorter since group chats move fast
- Don't react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect
The user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant (e.g., "nice ${chatContext.incomingEffect.name} effect!").`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform
This conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ` All features are available (reactions, effects, typing indicators, read receipts).`;
    } else if (chatContext.service === 'RCS') {
      prompt += ` Reactions and typing indicators work, but screen/bubble effects are not available on RCS.`;
    } else if (chatContext.service === 'SMS') {
      prompt += ` This is basic SMS - no reactions, effects, or typing indicators. Keep responses simple and concise.`;
    }
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction to the user\'s message. Use standard tapbacks (love, like, laugh, etc.) OR any custom emoji. Custom emoji reactions are great for more expressive responses!',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: 'The reaction type. Use "custom" to send any emoji.',
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom". The emoji to react with (e.g., "🔥", "💯", "🎉", "👀", "🙌").',
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add an iMessage effect to your text response. ONLY use when the user explicitly asks for an effect (e.g. "send lasers", "show me fireworks"). You MUST also write a text message - the effect enhances your text, it does not replace it. Do NOT use for normal conversation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: 'Whether this is a full-screen effect or a bubble effect',
      },
      effect: {
        type: 'string',
        enum: ['confetti', 'fireworks', 'lasers', 'sparkles', 'celebration', 'hearts', 'love', 'balloons', 'happy_birthday', 'echo', 'spotlight', 'slam', 'loud', 'gentle', 'invisible_ink'],
        description: 'The specific effect to use',
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const RENAME_CHAT_TOOL: Anthropic.Tool = {
  name: 'rename_group_chat',
  description: 'Rename the current group chat. ONLY use when someone EXPLICITLY asks to rename/name the chat (e.g., "name this chat", "rename the group"). Do NOT use unprompted or just because conversation is interesting. You MUST also send a text response when renaming.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'The new name for the group chat',
      },
    },
    required: ['name'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save NEW information about someone. ONLY use when you learn genuinely NEW info. NEVER re-save info already shown in the system prompt. CRITICAL: You MUST write a text response too - this tool does NOT send any message, so if you use it without text, the user gets nothing!',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The phone number/handle of the person this info is about. In group chats, use this to save info about someone OTHER than the current sender. If omitted, saves to the current sender.',
      },
      name: {
        type: 'string',
        description: 'The person\'s name if they shared it (e.g., "Patrick", "Sarah"). Set this whenever you learn someone\'s name!',
      },
      fact: {
        type: 'string',
        description: 'An interesting fact about them worth remembering (e.g., "Works at Google", "Has a dog named Max", "Loves hiking"). Keep facts concise.',
      },
    },
  },
};

const GENERATE_IMAGE_TOOL: Anthropic.Tool = {
  name: 'generate_image',
  description: 'Generate an image using DALL-E. Use when the user asks you to create, draw, generate, or make an image/picture/photo. Expand their request into a detailed prompt for better results. IMPORTANT: You MUST also write a brief text message (like "on it, making that corgi now" or "lemme draw that for u") - this message will be sent BEFORE the image starts generating so the user knows something is happening.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed description of the image to generate. Be specific about style, composition, lighting, etc. Example: "a fluffy corgi surfing on a wave, sunny day, action shot, ocean spray, photorealistic style"',
      },
    },
    required: ['prompt'],
  },
};

const SET_GROUP_ICON_TOOL: Anthropic.Tool = {
  name: 'set_group_chat_icon',
  description: 'Set the group chat icon/photo using a DALL-E generated image. ONLY use in group chats when someone explicitly asks to set/change the group icon/photo/picture. Expand their request into a detailed prompt. IMPORTANT: You MUST also write a brief text message acknowledging the request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed description of the image to generate for the group icon. Keep it simple and iconic - good for a small circular avatar. Example: "a cute cartoon corgi face, simple illustration style, centered composition"',
      },
    },
    required: ['prompt'],
  },
};

// Web search uses a special tool type - cast to bypass strict typing
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
  generatedImage: { url: string; prompt: string } | null;
  groupChatIcon: { prompt: string } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

// Generate an image using OpenAI DALL-E API
export async function generateImage(prompt: string): Promise<string | null> {
  try {
    console.log(`[claude] Generating image with DALL-E: "${prompt.substring(0, 50)}..."`);
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });

    const imageUrl = response.data?.[0]?.url;
    if (imageUrl) {
      console.log(`[claude] Image generated: ${imageUrl.substring(0, 50)}...`);
      return imageUrl;
    }
    console.error('[claude] No image URL in DALL-E response');
    return null;
  } catch (error) {
    console.error('[claude] DALL-E error:', error);
    return null;
  }
}

// Transcribe audio using OpenAI Whisper API
async function transcribeAudio(url: string): Promise<string | null> {
  try {
    console.log(`[claude] Fetching audio for transcription: ${url.substring(0, 50)}...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[claude] Failed to fetch audio: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/mp4';
    console.log(`[claude] Audio fetched: ${Math.round(arrayBuffer.byteLength / 1024)}KB, type: ${contentType}`);

    // Create a File-like object for the Whisper API
    const blob = new Blob([arrayBuffer], { type: contentType });
    const file = new File([blob], 'voice_memo.m4a', { type: contentType });

    console.log(`[claude] Transcribing with Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
    });

    console.log(`[claude] Transcription complete: "${transcription.text.substring(0, 50)}..."`);
    return transcription.text;
  } catch (error) {
    console.error(`[claude] Transcription error:`, error);
    return null;
  }
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
}

/**
 * Convert stored messages to Anthropic format, adding sender attribution for group chats.
 * In group chats, user messages are prefixed with the sender's handle so Claude knows who said what.
 */
function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map(msg => {
    let content = msg.content;

    // In group chats, prefix user messages with who sent them
    if (isGroupChat && msg.role === 'user' && msg.handle) {
      content = `[${msg.handle}]: ${content}`;
    }

    return {
      role: msg.role,
      content: content,
    };
  });
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
    generatedImage: null,
    groupChatIcon: null,
  };

  const cmd = userMessage.toLowerCase().trim();

  // Handle special commands
  if (cmd === '/help') {
    return {
      text: "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/help - this message",
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return {
      text: "conversation cleared, fresh start 🧹",
      ...emptyResponse,
    };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      return {
        text: "done, i've forgotten everything about you. we're strangers now 👋",
        ...emptyResponse,
      };
    }
    return {
      text: "hmm couldn't figure out who you are to forget you",
      ...emptyResponse,
    };
  }

  // Get conversation history (keyed by chat_id to keep conversations separate)
  const history = await getConversation(chatId);

  // Build message content (text + images + audio)
  const messageContent: Anthropic.ContentBlockParam[] = [];

  // Add images first
  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: {
        type: 'url',
        url: image.url,
      },
    });
    console.log(`[claude] Including image: ${image.url.substring(0, 50)}...`);
  }

  // Transcribe audio files and add as text context
  const transcriptions: string[] = [];
  let transcriptionFailed = false;
  for (const audioFile of audio) {
    const transcript = await transcribeAudio(audioFile.url);
    if (transcript) {
      transcriptions.push(transcript);
    } else {
      transcriptionFailed = true;
    }
  }

  // Build the text to send
  let textToSend = userMessage.trim();

  // If we have transcriptions, prepend them to the message
  if (transcriptions.length > 0) {
    const transcriptText = transcriptions.join('\n');
    if (textToSend) {
      textToSend = `[Voice memo transcript: "${transcriptText}"]\n\n${textToSend}`;
    } else {
      textToSend = `[Voice memo transcript: "${transcriptText}"]\n\nRespond naturally to what they said in the voice memo.`;
    }
  } else if (audio.length > 0 && transcriptionFailed) {
    // Transcription failed - let Claude know
    textToSend = textToSend || "[Someone sent a voice memo but transcription failed. Let them know you couldn't hear it and ask them to try again or type their message.]";
  } else if (!textToSend) {
    // Default prompts for images only (no audio, no text)
    if (images.length > 0) {
      textToSend = "What's in this image?";
    }
  }
  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  // Add user message to history with sender handle (for group chat attribution)
  if (textToSend) {
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);
  }

  try {
    if (chatContext?.isGroupChat) {
      console.log(`[claude] Group chat detected: ${chatContext.participantNames.length} participants`);
    }

    // Format history with sender attribution for group chats
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list - some tools only available in group chats
    const tools: Anthropic.Tool[] = [REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL];
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL, SET_GROUP_ICON_TOOL);
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(chatContext),
      tools,
      messages: [...formattedHistory, { role: 'user', content: messageContent }],
    });

    // Extract text response and tool calls
    const textParts: string[] = [];
    let reaction: Reaction | null = null;
    let effect: MessageEffect | null = null;
    let renameChat: string | null = null;
    let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;
    let generatedImage: { url: string; prompt: string } | null = null;
    let groupChatIcon: { prompt: string } | null = null;

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        if (input.type === 'custom' && input.emoji) {
          reaction = { type: 'custom', emoji: input.emoji };
          console.log(`[claude] Wants to react with custom emoji: ${input.emoji}`);
        } else if (input.type !== 'custom') {
          reaction = { type: input.type as StandardReactionType };
          console.log(`[claude] Wants to react with: ${input.type}`);
        }
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
        console.log(`[claude] Wants to send with effect: ${input.effect_type} - ${input.effect}`);
      } else if (block.type === 'tool_use' && block.name === 'rename_group_chat') {
        const input = block.input as { name: string };
        renameChat = input.name;
        console.log(`[claude] Wants to rename chat to: ${renameChat}`);
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string };
        // Use provided handle, or fall back to sender
        const targetHandle = input.handle || chatContext?.senderHandle;
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;

          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
            if (nameChanged) {
              console.log(`[claude] Remembered name for ${targetHandle}: ${input.name}`);
            } else {
              console.log(`[claude] Name already known for ${targetHandle}, skipped`);
            }
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
            if (factChanged) {
              console.log(`[claude] Remembered fact for ${targetHandle}: ${input.fact}`);
            } else {
              console.log(`[claude] Fact already known for ${targetHandle}, skipped`);
            }
          }

          // Only set rememberedUser if something actually changed
          if (nameChanged || factChanged) {
            const isForSender = !input.handle || input.handle === chatContext?.senderHandle;
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender
            };
          }
        }
      } else if (block.type === 'tool_use' && block.name === 'generate_image') {
        const input = block.input as { prompt: string };
        console.log(`[claude] Wants to generate image: ${input.prompt.substring(0, 50)}...`);
        // Don't generate yet - just capture the prompt. We'll generate after sending text.
        generatedImage = { url: '', prompt: input.prompt };
      } else if (block.type === 'tool_use' && block.name === 'set_group_chat_icon') {
        const input = block.input as { prompt: string };
        console.log(`[claude] Wants to set group icon: ${input.prompt.substring(0, 50)}...`);
        // Don't generate yet - just capture the prompt. We'll generate after sending text.
        groupChatIcon = { prompt: input.prompt };
      }
    }

    const textResponse = textParts.length > 0 ? textParts.join('\n') : null;

    // Add assistant response to history (only text part, strip --- delimiters for cleaner context)
    // Note: image generation is handled separately in index.ts after sending text first
    if (textResponse) {
      const historyMessage = textResponse.split('---').map(m => m.trim()).filter(m => m).join(' ');
      await addMessage(chatId, 'assistant', historyMessage);
    } else if (effect) {
      // Save effect-only responses so Claude knows what it did (prevents effect loops)
      await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
    } else if (reaction) {
      // Save reaction-only responses so Claude knows what it did (prevents reaction loops)
      const reactionDisplay = reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
      await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
    }

    return { text: textResponse, reaction, effect, renameChat, rememberedUser, generatedImage, groupChatIcon };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}

/**
 * Simple text-only completion for follow-up requests (no tools).
 */
export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }
  return `✨ ${effectName}! ✨`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

/**
 * Use Haiku to quickly determine how Claude should handle a group chat message.
 * Returns 'respond' (full message), 'react' (just tapback), or 'ignore'.
 */
export async function getGroupChatAction(
  message: string,
  sender: string,
  chatId: string
): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const start = Date.now();

  // Get recent conversation history for context (keyed by chat_id)
  const history = await getConversation(chatId);
  const recentMessages = history.slice(-4); // Last 2 exchanges

  let contextBlock = '';
  if (recentMessages.length > 0) {
    // Format with sender handles so Claude knows who said what
    const formatted = recentMessages.map(msg => {
      if (msg.role === 'assistant') {
        return `Claude: ${msg.content}`;
      } else {
        // Show who sent the message in group chats
        const sender = msg.handle || 'Someone';
        return `${sender}: ${msg.content}`;
      }
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
    console.log(`[claude] groupChatAction context (${recentMessages.length} msgs): ${formatted.substring(0, 100)}...`);
  } else {
    console.log(`[claude] groupChatAction context: no recent messages`);
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI assistant "Claude" should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions. Only use "react" for very brief acknowledgments where a text response would be awkward.

Answer with ONE of these:
- "respond" - Claude should send a text reply. USE THIS BY DEFAULT when:
  * They asked Claude anything
  * They mentioned Claude (or misspelled it - cluade, cloude, cladue, claud, etc.)
  * They mentioned "AI", "bot", "assistant", or "Sullivan"
  * They're talking to Claude or continuing a conversation
  * It's a follow-up to Claude's message
  * You're unsure - default to respond
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments where text would be weird (like a simple "thanks!" or "lol"). Do NOT overuse reactions.
- "ignore" - Human-to-human conversation not involving Claude at all

ANTI-REACTION-LOOP: If you see reactions in recent context, prefer "respond" to break the pattern. People want conversation, not tapbacks.

MISSPELLING TOLERANCE: People often typo "Claude" as cluade, cloude, cladue, claud, ckaude, etc. Treat these as mentions of Claude and respond!

Examples:
- "hey claude what's the weather" -> respond
- "cluade what do u think" -> respond (misspelling!)
- "cloude help me" -> respond (misspelling!)
- "claude thoughts?" -> respond
- "that's cool claude" -> respond (engage, don't just react!)
- "thanks!" (very brief, nothing to add) -> react:love
- "yo mike you coming tonight?" -> ignore`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Claude handle this?`
      }],
    });

    const answer = response.content[0].type === 'text'
      ? response.content[0].text.toLowerCase().trim()
      : 'ignore';

    let action: GroupChatAction = 'ignore';
    let reaction: Reaction | undefined;

    if (answer.includes('respond')) {
      action = 'respond';
    } else if (answer.includes('react')) {
      action = 'react';
      if (answer.includes('love')) reaction = { type: 'love' };
      else if (answer.includes('laugh')) reaction = { type: 'laugh' };
      else if (answer.includes('like')) reaction = { type: 'like' };
      else if (answer.includes('emphasize')) reaction = { type: 'emphasize' };
      else reaction = { type: 'like' }; // default reaction
    }

    const reactionDisplay = reaction ? (reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type) : '';
    console.log(`[claude] groupChatAction (${Date.now() - start}ms): "${message.substring(0, 50)}..." -> ${action}${reactionDisplay ? `:${reactionDisplay}` : ''}`);

    return { action, reaction };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
