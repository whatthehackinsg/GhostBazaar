#!/usr/bin/env node
/**
 * Ghost Bazaar MCP CLI — start the MCP server with stdio or HTTP/SSE transport.
 *
 * Usage:
 *   ghost-bazaar-mcp                          # stdio (default, for Claude Code CLI)
 *   ghost-bazaar-mcp --transport=stdio        # explicit stdio
 *   ghost-bazaar-mcp --transport=http --port=3001  # HTTP/SSE
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { createGhostBazaarServer } from "./server.js"

const args = process.argv.slice(2)
const transportArg = args.find((a) => a.startsWith("--transport="))?.split("=")[1] ?? "stdio"
const portArg = args.find((a) => a.startsWith("--port="))?.split("=")[1]
const port = portArg ? parseInt(portArg, 10) : 3001

async function main() {
  const config = loadConfig()
  const server = createGhostBazaarServer(config)

  if (transportArg === "stdio") {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  } else {
    process.stderr.write(`Unknown transport: ${transportArg}. Use "stdio" or "http".\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
