import { Ajv2020 } from "ajv/dist/2020.js";
import type { EvalDataset } from "./contracts.js";

const strings = { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 100 };
const turn = { type: "object", additionalProperties: false, properties: {
    content: { type: "string" }, status: { type: "integer", minimum: 400, maximum: 599 }, waitMs: { type: "integer", minimum: 0, maximum: 60000 }, hang: { type: "boolean" },
    calls: { type: "array", maxItems: 16, items: { type: "object", required: ["id", "name", "arguments"], additionalProperties: false,
        properties: { id: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } } } },
} };
const validate = new Ajv2020({ allErrors: false, strict: false }).compile({ type: "object", required: ["version", "id", "description", "cases"], additionalProperties: false,
    properties: { version: { const: 1 }, id: { type: "string", minLength: 1 }, description: { type: "string" }, cases: { type: "array", minItems: 1, maxItems: 200,
        items: { type: "object", required: ["id", "category", "kind", "modes", "question", "script", "expect"], additionalProperties: false, properties: {
            id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" }, category: { type: "string", minLength: 1 }, kind: { enum: ["task", "control"] }, modes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["offline", "live"] } },
            question: { type: "string", minLength: 1, maxLength: 12000 }, environment: { enum: ["workspace", "memory", "mcp"] },
            history: { type: "array", maxItems: 100, items: { type: "object", required: ["role", "content"], additionalProperties: false, properties: { role: { enum: ["user", "assistant"] }, content: { type: "string" } } } },
            historyPadding: { type: "integer", minimum: 0, maximum: 3000 }, script: { type: "array", minItems: 1, maxItems: 20, items: turn }, backupScript: { type: "array", minItems: 1, maxItems: 20, items: turn },
            repeatLast: { type: "boolean" }, summary: { type: "string" }, assertPromptIncludes: strings,
            cancelAfterMs: { type: "integer", minimum: 1, maximum: 60000 }, timeoutMs: { type: "integer", minimum: 5, maximum: 600000 }, attemptTimeoutMs: { type: "integer", minimum: 1, maximum: 600000 }, maxToolSteps: { type: "integer", minimum: 1, maximum: 10 },
            tools: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["name", "description"], properties: {
                name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,79}$" }, description: { type: "string", minLength: 1 }, inputs: { type: "object", additionalProperties: { enum: ["string", "integer"] } },
                output: { type: "string" }, operation: { enum: ["sum"] }, failFirst: { type: "integer", minimum: 0, maximum: 10 }, status: { type: "integer", minimum: 400, maximum: 599 }, readonly: { type: "boolean" }, idempotent: { type: "boolean" },
            } } },
            expect: { type: "object", required: ["outcome"], additionalProperties: false, properties: {
                outcome: { enum: ["success", "failure", "cancelled", "timed_out"] }, errorCode: { type: "string" }, facts: strings, evidenceFacts: strings, citations: strings, forbidden: strings, requiredTools: strings, allowedTools: strings, toolErrors: strings,
                maxToolCalls: { type: "integer", minimum: 0 }, minRetries: { type: "integer", minimum: 0 }, minFallbacks: { type: "integer", minimum: 0 }, minCompressions: { type: "integer", minimum: 0 },
                maxModelAttempts: { type: "integer", minimum: 0 }, maxRetries: { type: "integer", minimum: 0 }, maxFallbacks: { type: "integer", minimum: 0 },
                toolExecutions: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            } },
        } } } } });
export function parseDataset(value: unknown): EvalDataset {
    if (!validate(value)) throw new Error(`Invalid evaluation dataset: ${validate.errors?.[0]?.instancePath} ${validate.errors?.[0]?.message}`);
    const dataset = value as EvalDataset;
    if (new Set(dataset.cases.map(c => c.id)).size !== dataset.cases.length) throw new Error("Duplicate evaluation case ID");
    for (const c of dataset.cases) for (const pattern of [...(c.expect.facts ?? []), ...(c.expect.citations ?? []), ...(c.expect.forbidden ?? []), ...(c.assertPromptIncludes ?? [])]) {
        try { new RegExp(pattern, "iu"); } catch { throw new Error(`Invalid grader pattern in ${c.id}`); }
    }
    return structuredClone(dataset);
}
