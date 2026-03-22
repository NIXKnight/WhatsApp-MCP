# WhatsApp MCP Server

A production-ready Model Context Protocol (MCP) server that connects Claude (or any MCP-compatible client) to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys). This server runs WhatsApp via a personal WhatsApp account linked through QR code authentication.

## Features

The WhatsApp MCP Server exposes 12 tools to enable full WhatsApp automation:

1. **send_message** — Send plain-text messages to individual contacts with optional mentions and quote/reply support
2. **get_messages** — Retrieve the most recent messages from a chat
3. **list_contacts** — Return all known WhatsApp contacts
4. **get_contact** — Fetch metadata for a single contact by JID
5. **list_groups** — Return all WhatsApp groups you belong to
6. **get_group** — Fetch full group metadata including participant list and admin roles
7. **send_group_message** — Send messages to groups with optional mentions and quote/reply support
8. **send_media** — Send media files (images, videos, audio, documents) to contacts or groups
9. **download_media** — Download media attachments from received messages
10. **check_new_messages** — Lightweight polling to check for new messages since a given timestamp
11. **get_unread_chats** — Returns all chats with unread messages, including JID, name, unread count, and latest unread messages
12. **get_unread_messages** — Get unread messages from a specific chat

## Tech Stack

- **Node.js v20+**
- **TypeScript** — Type-safe implementation
- **Baileys v7** — Reverse-engineered WhatsApp Web client
- **MCP TypeScript SDK** — Model Context Protocol implementation
- **pino** — Structured logging to stderr
- **qrcode-terminal** — QR code rendering in terminal

## Project Structure

```
WhatsApp-MCP/
├── src/
│   ├── index.ts                 # MCP server entrypoint
│   ├── whatsapp.ts              # Baileys socket management & custom store
│   ├── store.ts                 # In-memory message/contact/chat store
│   ├── login.ts                 # QR code login utility
│   └── tools/
│       ├── messages.ts          # send_message, get_messages tools
│       ├── contacts.ts          # list_contacts, get_contact tools
│       ├── groups.ts            # list_groups, get_group, send_group_message tools
│       └── media.ts             # send_media, download_media tools
├── dist/                        # Compiled JavaScript (after build)
├── ~/.whatsapp-mcp/             # Persisted authentication credentials and store data (gitignored)
├── package.json
├── tsconfig.json
└── .gitignore
```

## Prerequisites

- **Node.js v20 or higher** — Ensure you have a compatible version installed
- **A WhatsApp account** — Use a primary or secondary number; be aware of WhatsApp ToS
- **A phone with WhatsApp installed** — Required for QR code linking (Linked Devices feature)

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/WhatsApp-MCP.git
cd WhatsApp-MCP
npm install
npm run build
```

## Authentication

Before the server can send and receive messages, you must authenticate your WhatsApp account via QR code.

### First-Time Login

Run the login utility to scan the QR code:

```bash
npm run login
```

The tool will:
1. Generate a QR code in your terminal
2. Prompt you to scan it with your phone via WhatsApp > Settings > Linked Devices > Link a Device
3. Save credentials to `~/.whatsapp-mcp/auth_info/` (gitignored)
4. Exit when authentication is complete

Credentials persist in the `~/.whatsapp-mcp/auth_info/` directory and are reused on subsequent server starts. You only need to run this once.

### Re-Authentication

If you see "Logged out" messages or need to re-authenticate:

```bash
rm -rf ~/.whatsapp-mcp/auth_info/
npm run login
```

## Configuration

### Claude Desktop

To use this server with Claude Desktop, add it to your Claude configuration file.

1. Open `~/.claude/claude_desktop_config.json` (create if missing)
2. Add the server entry:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/full/path/to/WhatsApp-MCP/dist/index.js"]
    }
  }
}
```

Replace `/full/path/to/WhatsApp-MCP` with the absolute path to your project.

3. Restart Claude Desktop
4. Verify the server appears in the "Tools" or "MCP" section of Claude

### Claude Code

To use with Claude Code:

```bash
cd /path/to/WhatsApp-MCP
claude mcp add whatsapp "npm run start"
```

Or configure manually in `~/.claude/claude_code_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npm",
      "args": ["run", "start"],
      "cwd": "/full/path/to/WhatsApp-MCP"
    }
  }
}
```

## Usage

Once connected to Claude or Claude Code, you can use natural language to interact with WhatsApp.

### Message Examples

**Send a text message:**
```
Send a WhatsApp message to 923001234567 saying "Hello, how are you?"
```

**List your groups:**
```
Show me all my WhatsApp groups
```

**Get recent messages:**
```
Get the last 10 messages from group 120363039783372408@g.us
```

**Send a message with a mention:**
```
Send a message to group 120363039783372408@g.us saying "Hey @923338894615, check this out!" and mention 923338894615@s.whatsapp.net
```

**Send a media file:**
```
Send the image at /home/user/photo.jpg to 923001234567 with caption "Check this out!"
```

**Download media:**
```
Download the media from message 3AEBEEF123ABC456 in chat 923001234567@s.whatsapp.net
```

**Get group details:**
```
Fetch metadata for group 120363039783372408@g.us including participant list
```

**Send a voice note:**
```
Send a voice note from /home/user/recording.ogg to 923001234567 with ptt enabled
```

**Check unread chats:**
```
Show me all my unread chats with message counts
```

**Get unread messages from a chat:**
```
Get unread messages from chat 923001234567@s.whatsapp.net
```

## Tool Reference

| Tool | Parameters | Returns |
|------|-----------|---------|
| `send_message` | `to` (phone), `text`, `mentions?`, `quotedMessageId?`, `quotedParticipant?` | Confirmation or error |
| `get_messages` | `jid` (chat ID), `limit?` (default 20) | Array of message objects |
| `list_contacts` | (none) | Array of contact objects |
| `get_contact` | `jid` (contact JID) | Single contact object or error |
| `list_groups` | (none) | Array of group objects |
| `get_group` | `jid` (group JID) | Full group metadata with participants |
| `send_group_message` | `jid` (group), `text`, `mentions?`, `quotedMessageId?`, `quotedParticipant?` | Confirmation or error |
| `send_media` | `to` (phone/JID), `filePath`, `caption?`, `mediaType?` (auto-detected), `ptt?` (push-to-talk for voice notes) | Confirmation or error |
| `download_media` | `messageId`, `jid`, `outputDir?` (default ./downloads) | File path on disk or error |
| `check_new_messages` | `since?` (timestamp in ms, default 0) | Array of new message objects |
| `get_unread_chats` | (none) | Array of unread chat objects with JID, name, unread count, and latest unread messages |
| `get_unread_messages` | `jid` (chat ID) | Array of unread message objects from the chat |

## Key Implementation Details

### Custom In-Memory Store

Baileys v7 removed `makeInMemoryStore()`. This server implements a minimal custom store that:

- Tracks chats, contacts, and message history in-memory
- Binds to Baileys socket events for automatic synchronization
- Provides helper functions in `store.ts` for querying data
- Serializes store data to `~/.whatsapp-mcp/store_data.json` for persistence across restarts

**Note:** The store is persisted to `~/.whatsapp-mcp/store_data.json` and survives restarts. Historical messages sync gradually after reconnection from WhatsApp servers.

### QR Code Rendering

Baileys v7 deprecated `printQRInTerminal()`. This server:

- Uses the `qrcode-terminal` package to generate ASCII QR codes
- Writes QR codes to **stderr** (not stdout) to preserve MCP JSON-RPC traffic on stdout
- Detects QR events during connection and renders them automatically

### Authentication & Versioning

- Uses `fetchLatestBaileysVersion()` to retrieve the latest WhatsApp Web protocol version
- Implements `makeCacheableSignalKeyStore()` for reliable key management
- Multi-file authentication state stored in `~/.whatsapp-mcp/auth_info/`

### Mentions and Quoting

**Mentions in Groups:**

For LID-addressed groups (modern group format), mentions are sent via `contextInfo.mentionedJid`:

```typescript
const contextInfo = {
  mentionedJid: ['923338894615@s.whatsapp.net', '923001234567@s.whatsapp.net']
};
```

Include `@number` in the message text for each mentioned user.

**Quoting/Replying:**

Quotes use three contextInfo fields:

```typescript
const contextInfo = {
  stanzaId: messageId,              // ID of message being quoted
  participant: senderJid,            // JID of message sender (or LID in groups)
  quotedMessage: messageObject       // The quoted message content
};
```

If the message is not in the local store, you may provide `quotedParticipant` explicitly.

### Logging

All diagnostic output (connection events, errors, warnings) is written to **stderr** (file descriptor 2). **Stdout is reserved exclusively for MCP JSON-RPC communication** to avoid protocol corruption.

The logger uses pino with minimal configuration and writes to stderr by default.

### Media Handling

**Sending Media:**

- File paths can be absolute or relative
- Media type is auto-detected from file extension (`.jpg`, `.mp4`, `.mp3`, `.pdf`, etc.)
- Manual override via `mediaType` parameter when needed
- Captions are supported for images, videos, and documents
- Voice notes: Set `ptt: true` to send audio as a WhatsApp voice note (push-to-talk). Requires OGG Opus format

**Downloading Media:**

- Media is downloaded via Baileys' `downloadContentFromMessage()` function
- Content type is determined from the message structure
- File extension is inferred from MIME type or content type
- Creates output directory if it doesn't exist

## Important Notes

### Single Session Restriction

Running this MCP server will disconnect any existing WhatsApp Web sessions. You cannot use WhatsApp Web elsewhere while this server is connected.

### Terms of Service Risk

Baileys is a reverse-engineered WhatsApp Web client. Using it may violate WhatsApp's Terms of Service. Consider:

- Using a secondary or business number
- Accepting the risk if using a primary personal number
- Testing in a non-critical environment first

### JID Formats

WhatsApp uses JID (Jabber ID) addresses in different formats:

- **Individual chats:** `{phone_number}@s.whatsapp.net`
  - Example: `923001234567@s.whatsapp.net`
  - Phone number should include country code with no `+` or spaces

- **Groups:** `{group_id}@g.us`
  - Example: `120363039783372408@g.us`
  - Group ID can be found via `list_groups`

- **LID format (modern groups):** `{id}@lid`
  - Used internally for participants in newer group formats
  - May appear in `contextInfo.participant` fields

### Phone Number Normalization

The `send_message` and `send_media` tools accept phone numbers in multiple formats:

- `923001234567` (pure digits)
- `+92 300 123 4567` (formatted)
- `92-300-123-4567` (dashes)

All non-digit characters are automatically stripped; only the numeric portion is used.

## Troubleshooting

**"WhatsApp not connected" errors:**

- Check if the MCP server is running (stderr should show connection status)
- Run `npm run login` to re-authenticate
- Verify your phone has WhatsApp installed and internet connectivity
- Check that no other WhatsApp Web session is active

**QR code not appearing:**

- Ensure you are running `npm run login` (not `npm run start`)
- Check that stderr output is visible (some terminal configurations may suppress it)
- Verify terminal supports ANSI characters for QR rendering

**Messages not sent:**

- Verify the recipient phone number or group JID is correct
- Check that your WhatsApp account has permission to message the recipient
- Inspect MCP server stderr logs for detailed error messages

**Media download fails:**

- Ensure the message ID and JID are correct
- The message must be in the local store (recent messages only)
- Check file system permissions for the output directory
- Verify the message actually contains downloadable media

## License

MIT
