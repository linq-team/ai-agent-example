import 'dotenv/config';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat, setGroupChatIcon, removeParticipant } from './linq/client.js';
import { chat, getGroupChatAction, getTextForEffect, generateImage, getOptOutConfirmationAction, getOptOutConfirmationPrompt, getOptOutAck } from './claude/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { getOptStatus, setPending, confirmOptOut, clearOpt, isOptOutKeyword } from './state/optOut.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Track message count per chat for contact card sharing
const chatMessageCount = new Map<string, number>();
const CONTACT_CARD_INTERVAL = 5; // Share every N messages

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Linq Blue
app.post(
  '/webhook',
  createWebhookHandler({
    onOptOut: async (handle, chatId) => {
      // Idempotent — first writer wins, duplicate signals (e.g. webhook + soft-intent
      // for the same STOP message) collapse into a single pending record.
      const created = await setPending(handle, 'webhook');
      if (!created) {
        console.log(`[main] opt-out: pending/opted_out already set for ${handle}, skipping confirmation`);
        return;
      }
      if (!chatId) {
        console.log(`[main] opt-out: no chat_id in payload, can't send confirmation`);
        return;
      }
      const prompt = await getOptOutConfirmationPrompt();
      await sendMessage(chatId, prompt);
      console.log(`[main] opt-out: sent confirmation to ${handle} in chat ${chatId}`);
    },
    onOptIn: async (handle, chatId) => {
      await clearOpt(handle);
      if (chatId) {
        await sendMessage(chatId, "ayy welcome back. lmk what's up");
      }
    },
    onMessage: async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${from}`);

    // Opt-out state machine — runs before any other processing.
    const optStatus = await getOptStatus(from);
    if (optStatus?.status === 'opted_out') {
      console.log(`[main] ${from} is opted out — skipping`);
      return;
    }
    if (optStatus?.status === 'pending') {
      const action = await getOptOutConfirmationAction(text);
      if (action === 'confirms') {
        await confirmOptOut(from);
        const ack = await getOptOutAck();
        await sendMessage(chatId, ack);
        console.log(`[main] opt-out confirmed for ${from} via reply classifier`);
        return;
      }
      // denies | unrelated → clear pending and fall through to normal flow
      await clearOpt(from);
      console.log(`[main] opt-out pending cleared for ${from} (reply: ${action})`);
    }

    // Linq fires `message.opt_out` for these literal keywords; let that
    // webhook drive the response so we don't double-process.
    if (isOptOutKeyword(text)) {
      console.log(`[main] Opt-out keyword "${text}" — deferring to message.opt_out webhook`);
      return;
    }

    // Track message count for this chat
    const count = (chatMessageCount.get(chatId) || 0) + 1;
    chatMessageCount.set(chatId, count);

    // Share contact card on first message or every N messages
    const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

    // Mark as read, start typing, get chat info, and fetch user profile in parallel
    const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
    if (shouldShareContact) {
      console.log(`[main] Sharing contact card (message #${count})`);
      parallelTasks.push(shareContactCard(chatId));
    }
    const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
    console.log(`[timing] markAsRead+startTyping+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    // Determine if this is a group chat (more than 2 participants)
    const isGroupChat = chatInfo.handles.length > 2;
    const participantNames = chatInfo.handles.map(h => h.handle);

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && audio.length === 0 && images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(messageId, quickReaction);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(chatId, 'user', text, from);
          const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
          await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

          console.log(`[main] Reacted to ${from} with ${reactionDisplay}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Get Claude's response (typing indicator shows while this runs)
    const { text: responseText, reaction, effect, renameChat, rememberedUser, generatedImage, groupChatIcon, removeMember } = await chat(chatId, text, images, audio, {
      isGroupChat,
      participantNames,
      chatName: chatInfo.display_name,
      incomingEffect,
      senderHandle: from,
      senderProfile,
      service,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, effect: ${effect ? JSON.stringify(effect) : 'null'}, renameChat: ${renameChat || 'null'}, generatedImage: ${generatedImage ? 'yes' : 'null'}, removeMember: ${removeMember || 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(messageId, reaction);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Rename group chat if Claude wants to
    if (renameChat && isGroupChat) {
      await renameGroupChat(chatId, renameChat);
      console.log(`[timing] renameChat: ${Date.now() - start}ms`);
    }

    // Remove member from group chat if Claude wants to
    if (removeMember && isGroupChat) {
      try {
        await removeParticipant(chatId, removeMember);
        console.log(`[timing] removeMember: ${Date.now() - start}ms`);
      } catch (error) {
        console.error(`[main] Failed to remove member ${removeMember}:`, error);
      }
    }

    // Send text response if there is one (with optional effect)
    // If Claude chose an effect but no text, get text from Haiku
    let finalText = responseText;
    if (!finalText && effect) {
      console.log(`[main] Claude sent effect without text, getting message from Haiku...`);
      finalText = await getTextForEffect(effect.name);
      console.log(`[timing] effect text followup: ${Date.now() - start}ms`);
    }

    // If Claude renamed chat but didn't send text, add a simple acknowledgment (group chats only)
    if (!finalText && renameChat && isGroupChat) {
      console.log(`[main] Claude renamed chat without text, adding acknowledgment`);
      finalText = `renamed the chat to "${renameChat}" 😎`;
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    // Claude should write its own response if it wants to acknowledge learning something
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    if (finalText || generatedImage || groupChatIcon) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText ? finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0) : [];

      // If the incoming message was a reply, continue the thread by replying to that message
      const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

      // Send text messages first (before generating image)
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;
          // Only apply effect to the last text message (if no image coming)
          const messageEffect = (isLastMessage && !generatedImage) ? effect ?? undefined : undefined;
          // Only thread the first message
          const messageReplyTo = (i === 0) ? replyTo : undefined;

          await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      // Now generate and send image if requested
      if (generatedImage) {
        // Show typing indicator while generating (takes ~15 seconds)
        await startTyping(chatId);
        console.log(`[main] Generating image after sending text...`);
        const imageUrl = await generateImage(generatedImage.prompt);
        if (imageUrl) {
          // Small delay before sending image
          await new Promise(resolve => setTimeout(resolve, 300));
          await sendMessage(chatId, '', effect ?? undefined, undefined, [{ url: imageUrl }]);
          // Save to conversation history
          await addMessage(chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`);
          console.log(`[timing] generateImage + sendImage: ${Date.now() - start}ms`);
        } else {
          // Image generation failed - let user know
          await sendMessage(chatId, 'sorry the image didnt work, try again?');
          console.log(`[main] Image generation failed`);
        }
      }

      // Generate and set group chat icon if requested
      if (groupChatIcon && isGroupChat) {
        // Show typing indicator while generating (takes ~15 seconds)
        await startTyping(chatId);
        console.log(`[main] Generating group chat icon...`);
        const imageUrl = await generateImage(groupChatIcon.prompt);
        if (imageUrl) {
          await setGroupChatIcon(chatId, imageUrl);
          // Save to conversation history
          await addMessage(chatId, 'assistant', `[set group chat icon]`);
          console.log(`[timing] generateIcon + setIcon: ${Date.now() - start}ms`);
        } else {
          // Image generation failed - let user know
          await sendMessage(chatId, 'sorry couldnt set the icon, try again?');
          console.log(`[main] Group icon generation failed`);
        }
      }

      const extras = [effect && 'effect', replyTo && 'thread', generatedImage && 'image', groupChatIcon && 'icon', removeMember && 'removeMember'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${from}`);
    },
  })
);

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         Linq Blue <-> Claude Bridge                   ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /webhook  - Linq Blue webhook receiver        ║
║    GET  /health   - Health check                      ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Configure webhook URL in Linq Blue              ║
║    3. Text your Linq Blue number!                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});
