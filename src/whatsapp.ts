import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  WASocket,
  Chat,
  Contact,
  WAMessage,
  BaileysEventEmitter,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// Logger MUST write to stderr (fd 2) — stdout is reserved for MCP JSON-RPC
const logger = pino({ level: 'warn' }, pino.destination(2));

// ---------------------------------------------------------------------------
// Minimal in-memory store (replaces the removed makeInMemoryStore from v7)
// ---------------------------------------------------------------------------

export interface SimpleStore {
  chats: Map<string, Chat>;
  contacts: Map<string, Contact>;
  /** Map from JID to ordered array of messages (oldest first). */
  messages: Map<string, WAMessage[]>;
  /** Bind the store to a socket's event emitter. */
  bind(ev: BaileysEventEmitter): void;
}

function makeSimpleStore(): SimpleStore {
  const chats = new Map<string, Chat>();
  const contacts = new Map<string, Contact>();
  const messages = new Map<string, WAMessage[]>();

  /** Upsert a chat keyed by its id. */
  function upsertChat(chat: Chat): void {
    const id = chat.id;
    if (!id) return;
    const existing = chats.get(id);
    if (existing) {
      chats.set(id, { ...existing, ...chat });
    } else {
      chats.set(id, chat);
    }
  }

  /** Append or update messages for a JID (keyed by message key.id). */
  function upsertMessages(jid: string, incoming: WAMessage[]): void {
    const existing = messages.get(jid) ?? [];
    const byId = new Map<string, WAMessage>(
      existing.map((m) => [m.key.id ?? '', m]),
    );
    for (const msg of incoming) {
      byId.set(msg.key.id ?? '', msg);
    }
    messages.set(jid, [...byId.values()]);
  }

  function bind(ev: BaileysEventEmitter): void {
    // History sync — bulk upsert
    ev.on('messaging-history.set', ({ chats: cs, contacts: cts, messages: msgs }) => {
      for (const c of cs) upsertChat(c);
      for (const ct of cts) {
        contacts.set(ct.id, ct);
      }
      // msgs are WAMessage[]
      for (const msg of msgs) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        upsertMessages(jid, [msg]);
      }
    });

    ev.on('chats.upsert', (cs) => {
      for (const c of cs) upsertChat(c);
    });

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const id = update.id;
        if (!id) continue;
        const existing = chats.get(id);
        if (existing) {
          chats.set(id, { ...existing, ...update } as Chat);
        }
      }
    });

    ev.on('chats.delete', (ids) => {
      for (const id of ids) chats.delete(id);
    });

    ev.on('contacts.upsert', (cts) => {
      for (const ct of cts) contacts.set(ct.id, ct);
    });

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (!update.id) continue;
        const existing = contacts.get(update.id);
        if (existing) {
          contacts.set(update.id, { ...existing, ...update } as Contact);
        } else if (update.id) {
          contacts.set(update.id, update as Contact);
        }
      }
    });

    ev.on('messages.upsert', ({ messages: msgs }) => {
      for (const msg of msgs) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        upsertMessages(jid, [msg]);
      }
    });

    ev.on('messages.update', (updates) => {
      for (const update of updates) {
        const jid = update.key.remoteJid;
        if (!jid) continue;
        const existing = messages.get(jid);
        if (!existing) continue;
        const idx = existing.findIndex((m) => m.key.id === update.key.id);
        if (idx !== -1 && update.update) {
          existing[idx] = { ...existing[idx], ...update.update };
        }
      }
    });

    ev.on('messages.delete', (item) => {
      if ('keys' in item) {
        for (const key of item.keys) {
          const jid = key.remoteJid;
          if (!jid) continue;
          const existing = messages.get(jid);
          if (!existing) continue;
          messages.set(
            jid,
            existing.filter((m) => m.key.id !== key.id),
          );
        }
      } else {
        messages.delete(item.jid);
      }
    });
  }

  return { chats, contacts, messages, bind };
}

// Global store instance shared with store.ts helpers
const store = makeSimpleStore();

let socket: WASocket | null = null;

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

/**
 * Returns the active WASocket instance.
 * Throws if WhatsApp is not yet connected.
 */
export function getSocket(): WASocket {
  if (!socket) {
    throw new Error('WhatsApp socket is not connected. Call connectToWhatsApp() first.');
  }
  return socket;
}

/**
 * Returns the in-memory store bound to the active socket.
 */
export function getStore(): SimpleStore {
  return store;
}

/**
 * Initialises the Baileys socket, binds the store, and manages reconnects.
 * Safe to call multiple times — if a socket already exists it is replaced
 * when a new connection is established.
 *
 * @param retryCount - Internal retry counter used for exponential backoff.
 */
export async function connectToWhatsApp(retryCount = 0): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    version,
  });

  // Bind the store to all socket events so it stays up to date
  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      process.stderr.write('\n[whatsapp] Scan this QR code with WhatsApp (Linked Devices → Link a Device):\n\n');
      qrcode.generate(qr, { small: true }, (code: string) => {
        // qrcode-terminal outputs to stdout by default, so we write to stderr manually
        process.stderr.write(code + '\n');
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      process.stderr.write(
        `[whatsapp] Connection closed. Status: ${statusCode ?? 'unknown'}. Logged out: ${loggedOut}\n`,
      );

      if (loggedOut) {
        process.stderr.write('[whatsapp] Logged out — delete auth_info/ and restart to re-authenticate.\n');
        socket = null;
        return;
      }

      if (retryCount >= MAX_RETRIES) {
        process.stderr.write(`[whatsapp] Max reconnect attempts (${MAX_RETRIES}) reached. Giving up.\n`);
        socket = null;
        return;
      }

      const delayMs = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      process.stderr.write(
        `[whatsapp] Reconnecting in ${delayMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})…\n`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await connectToWhatsApp(retryCount + 1);
    } else if (connection === 'open') {
      process.stderr.write('[whatsapp] Connected to WhatsApp\n');
      socket = sock;
      // Reset retry counter on successful connection by not carrying retryCount
    }
  });

  sock.ev.on('creds.update', saveCreds);
}
