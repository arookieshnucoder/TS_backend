import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile, writeFile } from 'node:fs/promises'
const server = new Server({ name: 'test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => params?.cursor === 'page2' ? {
  tools: [{ name: 'mutate', description: 'Update a record', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } }],
} : {
  tools: [{ name: 'lookup', description: 'Read nested input', inputSchema: {
    type: 'object', properties: { query: { type: 'string' }, options: { type: 'object', properties: { tags: { type: 'array', items: { enum: ['a','b'] } } }, additionalProperties: false } }, required: ['query'], additionalProperties: false,
  }, annotations: { readOnlyHint: true } }, { name: 'fail', description: 'Report an application error', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], nextCursor: 'page2',
})
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (process.argv[2] === 'drop-once') {
    try { await readFile(process.argv[3]) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(process.argv[3], 'dropped')
      setImmediate(() => process.exit(0))
      return new Promise(() => {})
    }
  }
  return params.name === 'fail' ? {
  isError: true, content: [{ type: 'text', text: 'Bearer private-server-key' }],
} : { content: [{ type: 'text', text: `evidence:${params.arguments?.query ?? 'written'}` }], structuredContent: { value: 42 } }
})
await server.connect(new StdioServerTransport())
