import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  downloadContentFromMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import { getSocket } from "../whatsapp.js";
import { getMessages } from "../store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MediaType = "image" | "video" | "document" | "audio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a MediaType from a file extension. Defaults to "document". */
function detectMediaType(filePath: string): MediaType {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
  const videoExts = new Set([".mp4", ".avi", ".mkv", ".mov"]);
  const audioExts = new Set([".mp3", ".ogg", ".wav", ".m4a"]);

  if (imageExts.has(ext)) return "image";
  if (videoExts.has(ext)) return "video";
  if (audioExts.has(ext)) return "audio";
  return "document";
}

/** Convert a phone number or JID to a proper WhatsApp JID. */
function toJid(input: string): string {
  // Already a valid JID (group or individual)
  if (input.endsWith("@g.us") || input.endsWith("@s.whatsapp.net")) {
    return input;
  }
  const digits = input.replace(/\D/g, "");
  if (digits.length < 10) {
    throw new Error(
      `Phone number "${input}" is too short after stripping non-digits ` +
        `(got ${digits.length} digits, need at least 10).`
    );
  }
  return `${digits}@s.whatsapp.net`;
}

/** Structured not-connected error response. */
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerMediaTools(server: McpServer): void {
  // -----------------------------------------------------------------------
  // send_media
  // -----------------------------------------------------------------------
  server.tool(
    "send_media",
    "Send a media file (image, video, audio, or document) to a WhatsApp " +
      "contact or group. `to` is a phone number with country code " +
      "(e.g. 923001234567) or a full JID (e.g. 120363039783372408@g.us for groups). " +
      "`filePath` is the absolute or relative path to " +
      "the file on disk. `mediaType` is auto-detected from the file extension " +
      "if omitted.",
    {
      to: z
        .string()
        .min(1)
        .describe(
          "Recipient phone number (e.g. 923001234567) or full JID (e.g. groupid@g.us)"
        ),
      filePath: z
        .string()
        .min(1)
        .describe("Path to the media file to send"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption text shown below the media"),
      mediaType: z
        .enum(["image", "video", "document", "audio"])
        .optional()
        .describe(
          "Media type override. Auto-detected from extension when omitted."
        ),
    },
    async ({ to, filePath, caption, mediaType }) => {
      let sock;
      try {
        sock = getSocket();
      } catch {
        return notConnectedResponse();
      }

      try {
        if (!fs.existsSync(filePath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: File not found at path "${filePath}".`,
              },
            ],
            isError: true,
          };
        }

        const jid = toJid(to);
        const resolvedType: MediaType = mediaType ?? detectMediaType(filePath);
        const fileUrl = { url: filePath };

        switch (resolvedType) {
          case "image":
            await sock.sendMessage(jid, {
              image: fileUrl,
              caption: caption ?? "",
            });
            break;
          case "video":
            await sock.sendMessage(jid, {
              video: fileUrl,
              caption: caption ?? "",
            });
            break;
          case "audio":
            await sock.sendMessage(jid, {
              audio: fileUrl,
              mimetype: "audio/mp4",
            });
            break;
          case "document": {
            const fileName = path.basename(filePath);
            const mimeType = "application/octet-stream";
            await sock.sendMessage(jid, {
              document: fileUrl,
              mimetype: mimeType,
              fileName,
              caption: caption ?? "",
            });
            break;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Media (${resolvedType}) sent successfully to ${jid}.`,
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
  // download_media
  // -----------------------------------------------------------------------
  server.tool(
    "download_media",
    "Download the media attachment from a received WhatsApp message and " +
      "save it to disk. Provide the `messageId` and `jid` (chat JID) to " +
      "locate the message in the local store. " +
      "`outputDir` defaults to ./downloads.",
    {
      messageId: z
        .string()
        .min(1)
        .describe("The id field of the WhatsApp message containing media"),
      jid: z
        .string()
        .min(1)
        .describe(
          "JID of the chat the message belongs to, e.g. 923001234567@s.whatsapp.net"
        ),
      outputDir: z
        .string()
        .optional()
        .describe(
          "Directory where the downloaded file will be saved (default: ./downloads)"
        ),
    },
    async ({ messageId, jid, outputDir }) => {
      try {
        // Locate the message in the store
        const messages: any[] = getMessages(jid, 200);
        const target = messages.find(
          (m: any) => m.key?.id === messageId
        );

        if (!target) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Message "${messageId}" not found in chat "${jid}". ` +
                  "Try fetching more messages or ensure the JID is correct.",
              },
            ],
            isError: true,
          };
        }

        if (!target.message) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Message "${messageId}" has no message content.`,
              },
            ],
            isError: true,
          };
        }

        // Determine content type and the nested message object
        const contentType = getContentType(target.message);
        if (!contentType) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Could not determine content type for message "${messageId}".`,
              },
            ],
            isError: true,
          };
        }

        const mediaMessage = target.message[contentType];
        if (!mediaMessage) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Error: Message "${messageId}" does not contain downloadable media ` +
                  `(type detected: ${contentType}).`,
              },
            ],
            isError: true,
          };
        }

        // Map Baileys content type to download stream type
        const streamTypeMap: Record<string, string> = {
          imageMessage: "image",
          videoMessage: "video",
          audioMessage: "audio",
          documentMessage: "document",
          stickerMessage: "sticker",
        };
        const streamType =
          streamTypeMap[contentType] ?? contentType.replace("Message", "");

        // Download into a buffer
        const stream = await downloadContentFromMessage(
          mediaMessage,
          streamType as Parameters<typeof downloadContentFromMessage>[1]
        );

        let buffer = Buffer.alloc(0);
        for await (const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
        }

        // Resolve output path
        const destDir = outputDir ?? "./downloads";
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        // Infer file extension from mimetype or content type
        const mimeToExt: Record<string, string> = {
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "video/mp4": ".mp4",
          "audio/ogg": ".ogg",
          "audio/mp4": ".m4a",
          "audio/mpeg": ".mp3",
          "application/pdf": ".pdf",
        };

        const mimetype: string | undefined =
          mediaMessage.mimetype;
        const ext =
          (mimetype && mimeToExt[mimetype]) ??
          "." + streamType.replace("Message", "");

        const fileName = `${messageId}${ext}`;
        const outputPath = path.join(destDir, fileName);

        fs.writeFileSync(outputPath, buffer);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Media downloaded successfully. Saved to: ${outputPath} ` +
                `(${buffer.length} bytes, type: ${contentType}).`,
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
}
