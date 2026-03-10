#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAttioMcpServer } from '../../src/attio-mcp/server.js';

const server = createAttioMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
await new Promise((resolve, reject) => {
  transport.onclose = resolve;
  transport.onerror = reject;
});
