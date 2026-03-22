import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import { getSocket } from "../whatsapp.js";
import { getMessages, getChats, getContacts } from "../store.js";

/**
 * Normalise a phone number string into a WhatsApp JID.
 * Strips all non-digit characters, validates minimum length,
 * then appends the individual-chat suffix.
 */
function phoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) {
    throw new Error(
      `Phone number "${phone}" is too short after stripping non-digits (got ${digits.length} digits, need at least 10).`
    );
  }
  return `${digits}@s.whatsapp.net`;
}

export function registerMessageTools(server: McpServer): void {
  // -----------------------------------------------------------------------
  // send_message
  // -----------------------------------------------------------------------
  server.tool(
    "send_message",
    "Send a plain-text WhatsApp message to an individual contact. " +
      "The `to` field must be a phone number including country code (e.g. 923001234567). " +
      "Non-digit characters are stripped automatically. " +
      "Optionally mention users by including @number in the text and providing their JIDs in `mentions`. " +
      "Optionally quote/reply to an existing message by providing its ID in `quotedMessageId`.",
    {
      to: z
        .string()
        .min(1)
        .describe(
          "Recipient phone number with country code, e.g. 923001234567"
        ),
      text: z.string().min(1).describe("Message body to send"),
      mentions: z
        .array(z.string())
        .optional()
        .describe(
          "Array of JIDs to mention/tag, e.g. ['923338894615@s.whatsapp.net']. " +
            "Include @number in the text for each mentioned user."
        ),
      quotedMessageId: z
        .string()
        .optional()
        .describe("Message ID to reply/quote"),
      quotedParticipant: z
        .string()
        .optional()
        .describe("Participant JID of the quoted message sender. Required for quoting if message is no longer in store."),
    },
    async ({ to, text, mentions, quotedMessageId, quotedParticipant }) => {
      try {
        const sock = getSocket();
        const jid = phoneToJid(to);

        const contextInfo: Record<string, unknown> = {};
        if (mentions && mentions.length > 0) {
          contextInfo.mentionedJid = mentions;
        }
        if (quotedMessageId) {
          const storeMessages = getMessages(jid, 200);
          const quoted = storeMessages.find(
            (m) => m.key.id === quotedMessageId
          );
          if (quoted) {
            contextInfo.stanzaId = quoted.key.id;
            contextInfo.participant = quoted.key.participant || quoted.participant;
            contextInfo.quotedMessage = quoted.message;
          } else {
            contextInfo.stanzaId = quotedMessageId;
            if (quotedParticipant) {
              contextInfo.participant = quotedParticipant;
            }
            contextInfo.quotedMessage = { conversation: "" };
          }
        }

        const messageContent = {
          text,
          ...(Object.keys(contextInfo).length > 0 ? { contextInfo } : {}),
        } as AnyMessageContent;

        await sock.sendMessage(jid, messageContent);
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent successfully to ${jid}.`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        const isNotConnected =
          message.toLowerCase().includes("not connected") ||
          message.toLowerCase().includes("socket");
        return {
          content: [
            {
              type: "text" as const,
              text: isNotConnected
                ? "WhatsApp not connected. Please scan the QR code."
                : `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // check_new_messages
  // -----------------------------------------------------------------------

  // Server-side memory: tracks last checked timestamp per jid+participant combo
  const lastChecked = new Map<string, number>();

  server.tool(
    "check_new_messages",
    "Lightweight poll for new messages in a chat. Automatically tracks the last " +
      "checked timestamp server-side — no need to pass it. Returns only unseen " +
      "messages, optionally filtered by participant. Returns compact summary or " +
      "'No new messages.' if nothing new.",
    {
      jid: z.string().min(1).describe("Chat JID to check"),
      participantFilter: z
        .string()
        .optional()
        .describe("Optional participant LID or JID to filter by, e.g. 259570677067973@lid"),
    },
    async ({ jid, participantFilter }) => {
      try {
        const key = `${jid}:${participantFilter ?? "all"}`;
        const since = lastChecked.get(key) ?? Math.floor(Date.now() / 1000);

        const allMessages = getMessages(jid, 100);
        const filtered = allMessages.filter((m) => {
          const ts = typeof m.messageTimestamp === "object"
            ? (m.messageTimestamp as { low: number }).low
            : Number(m.messageTimestamp);
          if (ts <= since) return false;
          if (m.key.fromMe) return false;
          if (!m.message) return false;
          if (m.message.protocolMessage || m.message.reactionMessage) return false;
          if (participantFilter && m.key.participant !== participantFilter) return false;
          return true;
        });

        // Update the watermark to the latest message timestamp or now
        const maxTs = filtered.reduce((max, m) => {
          const ts = typeof m.messageTimestamp === "object"
            ? (m.messageTimestamp as { low: number }).low
            : Number(m.messageTimestamp);
          return ts > max ? ts : max;
        }, since);
        lastChecked.set(key, maxTs);

        if (filtered.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        const summary = filtered.map((m) => {
          const msg = m.message;
          let text = "";
          if (msg?.conversation) text = msg.conversation;
          else if (msg?.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
          return {
            id: m.key.id,
            participant: m.key.participant,
            pushName: m.pushName ?? "",
            text,
            timestamp: Number(m.messageTimestamp),
          };
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: summary.length, messages: summary }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // get_messages
  // -----------------------------------------------------------------------
  server.tool(
    "get_messages",
    "Retrieve the most recent messages from a WhatsApp chat. " +
      "`jid` is the full WhatsApp JID (e.g. 923001234567@s.whatsapp.net or groupid@g.us). " +
      "`limit` defaults to 20.",
    {
      jid: z
        .string()
        .min(1)
        .describe(
          "WhatsApp JID of the chat, e.g. 923001234567@s.whatsapp.net"
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of messages to return (default 20)"),
    },
    async ({ jid, limit }) => {
      try {
        const messages = getMessages(jid, limit ?? 20);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // get_unread_chats
  // -----------------------------------------------------------------------
  server.tool(
    "get_unread_chats",
    "Returns all chats with unread messages. For each unread chat, returns the " +
      "chat JID, name (if available), unread count, and the latest unread messages. " +
      "Use this to check what new messages have arrived across all conversations.",
    {
      messageLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max messages to return per unread chat (default 5)"),
    },
    async ({ messageLimit }) => {
      try {
        const chats = getChats();
        const contacts = getContacts();
        const limit = messageLimit ?? 5;

        const contactMap = new Map<string, string>();
        for (const c of contacts) {
          const name = c.name || c.notify || "";
          if (name) contactMap.set(c.id, name);
        }

        const unreadChats = chats.filter(
          (c) => c.unreadCount && c.unreadCount > 0
        );

        if (unreadChats.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No unread chats." }],
          };
        }

        const result = unreadChats.map((chat) => {
          const jid = chat.id ?? "";
          const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
          const chatName =
            chat.name ||
            (chat as Record<string, unknown>).conversationTitle ||
            contactMap.get(jid) ||
            jid;

          const messages = getMessages(jid, limit);
          const messageSummary = messages
            .filter((m) => !m.key.fromMe && m.message)
            .filter(
              (m) =>
                !m.message?.protocolMessage && !m.message?.reactionMessage
            )
            .map((m) => {
              const msg = m.message;
              let text = "";
              if (msg?.conversation) text = msg.conversation;
              else if (msg?.extendedTextMessage?.text)
                text = msg.extendedTextMessage.text;
              else if (msg?.imageMessage) text = "[Image]" + (msg.imageMessage.caption ? " " + msg.imageMessage.caption : "");
              else if (msg?.videoMessage) text = "[Video]" + (msg.videoMessage.caption ? " " + msg.videoMessage.caption : "");
              else if (msg?.audioMessage) text = "[Audio]";
              else if (msg?.documentMessage) text = "[Document]" + (msg.documentMessage.fileName ? " " + msg.documentMessage.fileName : "");
              else if (msg?.stickerMessage) text = "[Sticker]";
              else text = "[Media]";

              return {
                id: m.key.id,
                participant: m.key.participant || "",
                pushName: m.pushName ?? "",
                text,
                timestamp: Number(m.messageTimestamp),
              };
            });

          return {
            jid,
            name: chatName,
            isGroup,
            unreadCount: chat.unreadCount,
            messages: messageSummary,
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { unreadChats: result.length, chats: result },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // get_unread_messages
  // -----------------------------------------------------------------------
  server.tool(
    "get_unread_messages",
    "Returns a flat list of all unread messages across all chats, sorted by " +
      "timestamp (newest first). Each message includes the chat JID, chat name, " +
      "sender name, text, and timestamp. Use this for a quick overview of " +
      "everything unread.",
    {},
    async () => {
      try {
        const chats = getChats();
        const contacts = getContacts();

        const contactMap = new Map<string, string>();
        for (const c of contacts) {
          const name = c.name || c.notify || "";
          if (name) contactMap.set(c.id, name);
        }

        const unreadChats = chats.filter(
          (c) => c.unreadCount && c.unreadCount > 0
        );

        if (unreadChats.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No unread messages." }],
          };
        }

        const allUnread: Array<{
          chatJid: string;
          chatName: string;
          isGroup: boolean;
          messageId: string;
          participant: string;
          senderName: string;
          text: string;
          timestamp: number;
        }> = [];

        for (const chat of unreadChats) {
          const jid = chat.id ?? "";
          const isGroup = typeof jid === "string" && jid.endsWith("@g.us");
          const chatName =
            chat.name ||
            (chat as Record<string, unknown>).conversationTitle ||
            contactMap.get(jid) ||
            jid;

          const count = chat.unreadCount ?? 5;
          const messages = getMessages(jid, Math.min(count, 20));

          for (const m of messages) {
            if (m.key.fromMe) continue;
            if (!m.message) continue;
            if (m.message.protocolMessage || m.message.reactionMessage) continue;

            const msg = m.message;
            let text = "";
            if (msg.conversation) text = msg.conversation;
            else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
            else if (msg.imageMessage) text = "[Image]" + (msg.imageMessage.caption ? " " + msg.imageMessage.caption : "");
            else if (msg.videoMessage) text = "[Video]" + (msg.videoMessage.caption ? " " + msg.videoMessage.caption : "");
            else if (msg.audioMessage) text = "[Audio]";
            else if (msg.documentMessage) text = "[Document]" + (msg.documentMessage.fileName ? " " + msg.documentMessage.fileName : "");
            else if (msg.stickerMessage) text = "[Sticker]";
            else text = "[Media]";

            const participant = m.key.participant || m.key.remoteJid || "";
            const senderName = m.pushName || contactMap.get(participant) || participant;

            allUnread.push({
              chatJid: jid,
              chatName: String(chatName),
              isGroup,
              messageId: m.key.id || "",
              participant,
              senderName,
              text,
              timestamp: Number(m.messageTimestamp),
            });
          }
        }

        allUnread.sort((a, b) => b.timestamp - a.timestamp);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { totalUnread: allUnread.length, messages: allUnread },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
