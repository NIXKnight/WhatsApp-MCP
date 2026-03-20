import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getContacts } from "../store.js";

export function registerContactTools(server: McpServer): void {
  // -----------------------------------------------------------------------
  // list_contacts
  // -----------------------------------------------------------------------
  server.tool(
    "list_contacts",
    "Return all WhatsApp contacts currently known to the local store. " +
      "Each entry contains at minimum an `id` (JID) field, plus name and " +
      "notify fields when available.",
    {},
    async () => {
      try {
        const contacts = getContacts();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(contacts, null, 2),
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
  // get_contact
  // -----------------------------------------------------------------------
  server.tool(
    "get_contact",
    "Return metadata for a single WhatsApp contact by their JID " +
      "(e.g. 923001234567@s.whatsapp.net). Searches the local store.",
    {
      jid: z
        .string()
        .min(1)
        .describe(
          "Full WhatsApp JID of the contact, e.g. 923001234567@s.whatsapp.net"
        ),
    },
    async ({ jid }) => {
      try {
        const contacts = getContacts();
        // store.ts returns Contact[] — each Contact has an `id` field (the JID)
        const contact = contacts.find(
          (c: { id?: string }) => c.id === jid
        );

        if (!contact) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Contact with JID "${jid}" not found in store.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(contact, null, 2),
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
