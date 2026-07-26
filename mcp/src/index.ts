import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { handleCallTool } from './handlers.js';
import { initAuth } from './auth.js';
import { initDb } from '../../server/src/db.js';
import { ensureNetwork } from '../../server/src/docker.js';
import { ensureMinio } from '../../server/src/minio.js';

async function main() {
  // Initialize the same dependencies as the main server
  initDb();
  await ensureNetwork();
  await ensureMinio();
  await initAuth();

  const server = new Server(
    { name: 'dockyard', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, handleCallTool);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Dockyard MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
