#!/usr/bin/env node
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

let retryCount = 0;
const MAX_RETRIES = 5;

async function login() {
  console.log('WhatsApp MCP — Login\n');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys v${version.join('.')}, latest: ${isLatest}\n`);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    version,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr: qrData } = update;

    console.log('Connection update:', JSON.stringify({ connection, qr: qrData ? '(present)' : undefined, lastDisconnect: lastDisconnect?.error?.message }));

    if (qrData) {
      console.log('\nScan this QR code with WhatsApp:');
      console.log('(Settings → Linked Devices → Link a Device)\n');
      qrcode.generate(qrData, { small: true });
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      console.error(`Connection closed. Status: ${statusCode}, Error: ${error?.message ?? 'unknown'}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Logged out. Delete auth_info/ directory and try again.');
        process.exit(1);
      }

      retryCount++;
      if (retryCount > MAX_RETRIES) {
        console.error(`Max retries (${MAX_RETRIES}) reached. Giving up.`);
        process.exit(1);
      }

      const delayMs = 1000 * Math.pow(2, retryCount - 1);
      console.log(`Retrying in ${delayMs}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
      setTimeout(() => login(), delayMs);
    } else if (connection === 'open') {
      retryCount = 0;
      console.log('\n✓ Successfully connected to WhatsApp!');
      console.log('Auth credentials saved to auth_info/');
      console.log('You can now use the MCP server.\n');
      setTimeout(() => process.exit(0), 2000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

login().catch((err) => {
  console.error('Login failed:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
