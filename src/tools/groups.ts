import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import { getSocket } from "../whatsapp.js";
import { getChats, getMessages } from "../store.js";

/** Guard: return a structured error when WhatsApp is not connected. */
function notConnectedResponse() {
  return {
    content: [
      {
        type: "text" as const,
        text: "WhatsApp not connected. Please scan the QR code.",
      },
    ],
    isError: true as const,
  };
}

export function registerGroupTools(server: McpServer): void {
  // -----------------------------------------------------------------------
  // list_groups
  // -----------------------------------------------------------------------
  server.tool(
    "list_groups",
    "Return all WhatsApp group chats the account belongs to. " +
      "Groups are identified by JIDs ending with @g.us.",
    {},
    async () => {
      try {
        const chats = getChats();
        const groups = chats.filter(
          (chat) =>
            typeof chat.id === "string" && chat.id.endsWith("@g.us")
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(groups, null, 2),
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
          isError: true as const,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // get_group
  // -----------------------------------------------------------------------
  server.tool(
    "get_group",
    "Fetch full metadata for a WhatsApp group via the live socket, " +
      "including participant list and admin roles. " +
      "`jid` must end with @g.us.",
    {
      jid: z
        .string()
        .min(1)
        .regex(/^.+@g\.us$/, "jid must be a group JID ending with @g.us")
        .describe("Group JID, e.g. 12345678901234567890@g.us"),
    },
    async ({ jid }) => {
      let sock;
      try {
        sock = getSocket();
      } catch {
        return notConnectedResponse();
      }

      try {
        const metadata = await sock.groupMetadata(jid);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(metadata, null, 2),
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
          isError: true as const,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // send_group_message
  // -----------------------------------------------------------------------
  server.tool(
    "send_group_message",
    "Send a plain-text message to a WhatsApp group chat. " +
      "`jid` must be a group JID ending with @g.us. " +
      "Optionally mention users by including @number in the text and providing their JIDs in `mentions`. " +
      "Optionally quote/reply to an existing message by providing its ID in `quotedMessageId`.",
    {
      jid: z
        .string()
        .min(1)
        .regex(/^.+@g\.us$/, "jid must be a group JID ending with @g.us")
        .describe("Group JID, e.g. 12345678901234567890@g.us"),
      text: z.string().min(1).describe("Message text to send to the group"),
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
        .describe("Participant JID (LID or phone) of the quoted message sender. Required for quoting if message is no longer in store."),
    },
    async ({ jid, text, mentions, quotedMessageId, quotedParticipant }) => {
      let sock;
      try {
        sock = getSocket();
      } catch {
        return notConnectedResponse();
      }

      try {
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
            // Fallback: message not in store, construct from provided params
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
              text: `Message sent successfully to group ${jid}.`,
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
          isError: true as const,
        };
      }
    }
  );
}
