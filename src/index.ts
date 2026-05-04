#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BillSpendClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const client = new BillSpendClient();
  const server = new McpServer({
    name: "billcom-spend-expense",
    version: "0.1.0",
  });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("billcom-spend-mcp-server failed to start:", err);
  process.exit(1);
});
