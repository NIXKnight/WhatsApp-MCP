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
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import * as path from 'path';
import * as fs from 'fs';

export const DATA_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.whatsapp-mcp');
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
const STORE_FILE = path.join(DATA_DIR, 'store_data.json');
const LOG_FILE = path.join(DATA_DIR, 'sync.log');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Logger MUST write to stderr (fd 2) — stdout is reserved for MCP JSON-RPC
const logger = pino({ level: 'warn' }, pino.destination(2));

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  process.stderr.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

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
  /** Persist store data to disk. */
  saveToFile(): void;
  /** Load store data from disk. */
  loadFromFile(): void;
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
      for (const msg of msgs) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        upsertMessages(jid, [msg]);
      }
      log(`[sync] History sync received: ${cs.length} chats, ${cts.length} contacts, ${msgs.length} messages`);
    });

    ev.on('chats.upsert', (cs) => {
      for (const c of cs) upsertChat(c);
      log(`[sync] Chats upsert: ${cs.length} chats`);
    });

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const id = update.id;
        if (!id) continue;
        const existing = chats.get(id);
        if (existing) {
          chats.set(id, { ...existing, ...update } as Chat);
        } else {
          chats.set(id, update as Chat);
        }
      }
      log(`[sync] Chats update: ${updates.length} chats (store now: ${chats.size})`);
    });

    ev.on('chats.delete', (ids) => {
      for (const id of ids) chats.delete(id);
    });

    ev.on('contacts.upsert', (cts) => {
      for (const ct of cts) contacts.set(ct.id, ct);
      log(`[sync] Contacts upsert: ${cts.length} contacts`);
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
      log(`[sync] Contacts update: ${updates.length} contacts`);
    });

    ev.on('messages.upsert', ({ messages: msgs }) => {
      for (const msg of msgs) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;
        upsertMessages(jid, [msg]);
      }
      log(`[sync] Messages upsert: ${msgs.length} messages`);
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

  let lastSavedSummary = '';

  function saveToFile(): void {
    try {
      const data = {
        chats: Array.from(chats.entries()),
        contacts: Array.from(contacts.entries()),
        messages: Array.from(messages.entries()),
      };
      fs.writeFileSync(STORE_FILE, JSON.stringify(data), 'utf-8');
      const summary = `${chats.size} chats, ${contacts.size} contacts, ${messages.size} threads`;
      if (summary !== lastSavedSummary) {
        log(`[store] Saved: ${summary}`);
        lastSavedSummary = summary;
      }
    } catch (err) {
      log(`[store] Error saving store: ${err}`);
    }
  }

  function loadFromFile(): void {
    try {
      if (!fs.existsSync(STORE_FILE)) return;
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const data = JSON.parse(raw) as {
        chats?: [string, Chat][];
        contacts?: [string, Contact][];
        messages?: [string, WAMessage[]][];
      };
      if (data.chats) {
        for (const [k, v] of data.chats) chats.set(k, v);
      }
      if (data.contacts) {
        for (const [k, v] of data.contacts) contacts.set(k, v);
      }
      if (data.messages) {
        for (const [k, v] of data.messages) messages.set(k, v);
      }
      log(`[store] Loaded store from disk: ${chats.size} chats, ${contacts.size} contacts, ${messages.size} message threads`);
    } catch (err) {
      log(`[store] Error loading store: ${err}`);
    }
  }

  return { chats, contacts, messages, bind, saveToFile, loadFromFile };
}

// Global store instance shared with store.ts helpers
const store = makeSimpleStore();
store.loadFromFile();

setInterval(() => {
  store.saveToFile();
}, 30_000);

process.on('SIGINT', () => {
  store.saveToFile();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.saveToFile();
  process.exit(0);
});

let socket: WASocket | null = null;
let isReconnecting = false;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

let cachedVersion: [number, number, number] | null = null;
let cachedAuthState: Awaited<ReturnType<typeof useMultiFileAuthState>> | null = null;

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
  if (isReconnecting) {
    log('[connection] Reconnect already in progress. Skipping.');
    return;
  }
  isReconnecting = true;

  if (!cachedAuthState) {
    cachedAuthState = await useMultiFileAuthState(AUTH_DIR);
  }
  if (!cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  }
  const { state, saveCreds } = cachedAuthState;

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    version: cachedVersion,
    syncFullHistory: true,
    browser: Browsers.macOS('Desktop'),
    keepAliveIntervalMs: 30_000,
  });

  // Bind the store to all socket events so it stays up to date
  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('[connection] QR code generated, waiting for scan...');
      process.stderr.write('\n[whatsapp] Scan this QR code with WhatsApp (Linked Devices → Link a Device):\n\n');
      qrcode.generate(qr, { small: true }, (code: string) => {
        // qrcode-terminal outputs to stdout by default, so we write to stderr manually
        process.stderr.write(code + '\n');
      });
    }

    if (connection === 'close') {
      isReconnecting = false;
      socket = null;

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      log(`[connection] Closed. Status: ${statusCode ?? 'unknown'}.`);

      // Permanent disconnections — do not reconnect
      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
        log('[connection] Permanent disconnection. Re-authentication required.');
        return;
      }

      // Session replaced (440) or restart required (515) — immediate fresh reconnect, no backoff
      if (statusCode === DisconnectReason.connectionReplaced || statusCode === DisconnectReason.restartRequired) {
        log('[connection] Reconnecting immediately (fresh).');
        await connectToWhatsApp(0);
        return;
      }

      // All other codes — exponential backoff
      const delayMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
      log(`[connection] Reconnecting in ${delayMs}ms (attempt ${retryCount + 1}).`);
      await new Promise(r => setTimeout(r, delayMs));
      const nextRetry = delayMs >= MAX_BACKOFF_MS ? 0 : retryCount + 1;
      await connectToWhatsApp(nextRetry);
    } else if (connection === 'open') {
      isReconnecting = false;
      log('[connection] Connected to WhatsApp');
      socket = sock;
    }
  });

  sock.ev.on('creds.update', saveCreds);
}
