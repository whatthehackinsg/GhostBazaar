/**
 * Ghost Bazaar MCP Server — exposes negotiation + settlement tools to
 * Claude Code and MCP-compatible agents.
 *
 * Supports stdio (primary) and HTTP/SSE (secondary) transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { defineBuyerTools, createBuyerState } from "./tools/buyer.js"
import { defineSellerTools, createSellerState } from "./tools/seller.js"
import type { McpConfig } from "./config.js"

export function createGhostBazaarServer(config: McpConfig): McpServer {
  const server = new McpServer({
    name: "ghost-bazaar",
    version: "0.1.0",
  })

  const buyerState = createBuyerState()
  const sellerState = createSellerState()
  const buyerTools = defineBuyerTools(config, buyerState)
  const sellerTools = defineSellerTools(config, sellerState)

  // Register buyer tools
  for (const [name, tool] of Object.entries(buyerTools)) {
    server.tool(name, tool.description, tool.inputSchema.shape, tool.handler as any)
  }

  // Register seller tools
  for (const [name, tool] of Object.entries(sellerTools)) {
    server.tool(name, tool.description, tool.inputSchema.shape, tool.handler as any)
  }

  return server
}
