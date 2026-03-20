/**
 * WhatsApp MCP Server — Entrypoint
 *
 * Stdout is reserved exclusively for MCP JSON-RPC traffic.
 * All diagnostic output (startup messages, errors, WhatsApp logs)
 * must go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectToWhatsApp } from "./whatsapp.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerMediaTools } from "./tools/media.js";

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Instantiate the MCP server
  // -------------------------------------------------------------------------
  const server = new McpServer({
    name: "whatsapp",
    version: "1.0.0",
  });

  // -------------------------------------------------------------------------
  // 2. Connect to WhatsApp and wait until the socket is ready
  //    connectToWhatsApp() handles QR display, auth state, reconnection.
  //    It resolves once the "connection.update" open event fires.
  // -------------------------------------------------------------------------
  console.error("[whatsapp-mcp] Connecting to WhatsApp...");
  try {
    await connectToWhatsApp();
    console.error("[whatsapp-mcp] WhatsApp connection established.");
  } catch (err) {
    // Non-fatal: tools will return "not connected" responses if the socket
    // is unavailable. The server still starts so the MCP client can discover
    // tools and the user can scan the QR code later.
    console.error(
      "[whatsapp-mcp] Warning: WhatsApp connection failed during startup:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // -------------------------------------------------------------------------
  // 3. Register all tool categories
  // -------------------------------------------------------------------------
  registerMessageTools(server);
  registerContactTools(server);
  registerGroupTools(server);
  registerMediaTools(server);

  console.error(
    "[whatsapp-mcp] Tools registered: messages, contacts, groups, media."
  );

  // -------------------------------------------------------------------------
  // 4. Connect the stdio transport — after this point stdout belongs to MCP
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[whatsapp-mcp] MCP server listening on stdio.");
}

main().catch((err) => {
  console.error(
    "[whatsapp-mcp] Fatal error during startup:",
    err instanceof Error ? err.stack ?? err.message : String(err)
  );
  process.exit(1);
});
