import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolInputError, ToolExecutionError, type RegisteredTool } from "../harness/tool-contracts.js";

export function mcpToolName(serverId: string, toolName: string): string {
    const hash = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 16);
    return `mcp_${serverId.slice(0, 16)}_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}_${hash}`;
}
export function toolResultText(result: CallToolResult): string {
    if (result.isError) throw new ToolExecutionError("MCP tool reported failure");
    const content = result.content.map(block => {
        if (block.type === "text") return block.text;
        if (block.type === "resource" && "text" in block.resource) return `${block.resource.uri}\n${block.resource.text}`;
        if (block.type === "resource_link") return JSON.stringify({ type: block.type, name: block.name, uri: block.uri, description: block.description });
        return `[MCP ${block.type} content omitted: this agent accepts text results.]`;
    });
    if (result.structuredContent) content.push(JSON.stringify(result.structuredContent));
    return content.join("\n");
}
export function adaptMcpTool(serverId: string, tool: Tool,
    execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>): RegisteredTool {
    if (!tool.name || tool.name.length > 256 || JSON.stringify(tool.inputSchema).length > 64000) throw new Error("MCP schema exceeds limits");
    const schema = structuredClone(tool.inputSchema);
    // Both draft-07 and 2020-12 metadata occur in third-party MCP servers.
    const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
    ajv.addMetaSchema(createRequire(import.meta.url)("ajv/dist/refs/json-schema-draft-07.json"));
    const validate = ajv.compile(schema);
    return {
        readonly: tool.annotations?.readOnlyHint === true,
        // Server annotations are advisory; host authorization is enforced by McpManager too.
        idempotent: tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
        source: { type: "mcp", serverId, toolName: tool.name },
        definition: { name: mcpToolName(serverId, tool.name), description: `[MCP ${serverId}/${tool.name}] ${(tool.description ?? tool.name).slice(0, 4000)}`, parameters: schema },
        validate(input) { if (!validate(input)) throw new ToolInputError("MCP arguments do not match the tool's JSON Schema."); },
        async execute(input, signal) {
            signal?.throwIfAborted();
            if (!validate(input)) throw new ToolInputError("MCP arguments do not match the tool's JSON Schema.");
            return toolResultText(await execute(input, signal));
        },
    };
}
