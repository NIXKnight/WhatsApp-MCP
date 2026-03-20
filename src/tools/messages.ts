import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import { getSocket } from "../whatsapp.js";
import { getMessages } from "../store.js";

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
}
