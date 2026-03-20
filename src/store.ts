import type { proto, Chat, Contact, WAMessage } from '@whiskeysockets/baileys';
import { getStore } from './whatsapp.js';

/**
 * Retrieves the most recent messages for a given chat JID from the in-memory
 * store.
 *
 * @param jid   - The WhatsApp JID of the chat (e.g. "1234567890@s.whatsapp.net").
 * @param limit - Maximum number of messages to return (default: 50).
 * @returns     An array of WAMessage ordered oldest-first.
 */
export function getMessages(jid: string, limit = 50): WAMessage[] {
  const store = getStore();
  const all = store.messages.get(jid);

  if (!all || all.length === 0) {
    process.stderr.write(`[store] No messages found in store for JID: ${jid}\n`);
    return [];
  }

  // Return the last `limit` entries (most recent)
  return all.slice(-limit);
}

/**
 * Returns all chats currently tracked by the in-memory store.
 *
 * @returns An array of Chat objects.
 */
export function getChats(): Chat[] {
  const store = getStore();
  return [...store.chats.values()];
}

/**
 * Returns all contacts currently tracked by the in-memory store.
 *
 * @returns An array of Contact objects.
 */
export function getContacts(): Contact[] {
  const store = getStore();
  return [...store.contacts.values()];
}

// Re-export proto for consumers that need message type inspection
export type { proto };
