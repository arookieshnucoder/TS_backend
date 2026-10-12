import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server=new Server({name:'evaluation-notes',version:'1.0.0'},{capabilities:{tools:{}}})
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'lookup_note',description:'Search an isolated evaluation note by query.',
  inputSchema:{type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true}}]}))
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'Evaluation note: release R7, owner Mira. Source mcp:eval/lookup_note.'}]}))
await server.connect(new StdioServerTransport())
