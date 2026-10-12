import type { EvalCase, EvalEvent, Grade, Outcome } from "./contracts.js";

export const GRADER_VERSION = "agent-harness-grader-v1";
export function toolName(fields: Record<string, unknown>): string {
    const source = fields.source as { type?: string; serverId?: string; toolName?: string } | undefined;
    return source?.type === "mcp" ? `mcp:${source.serverId}/${source.toolName}` : String(fields.tool ?? "");
}
const coverage = (patterns: string[], text: string) => patterns.length ? patterns.filter(p => new RegExp(p, "iu").test(text)).length / patterns.length : null;
export function grade(c: EvalCase, outcome: Outcome, answer: string, events: EvalEvent[], executions: Record<string, number>, errorCode?: string): Grade {
    const failures: string[] = [];
    const expected = c.expect;
    if (outcome !== expected.outcome) failures.push(`outcome:${expected.outcome}->${outcome}`);
    if (expected.errorCode && expected.errorCode !== errorCode) failures.push(`error_code:${expected.errorCode}->${errorCode ?? "none"}`);
    const factCoverage = coverage(expected.facts ?? [], answer), citationCoverage = coverage(expected.citations ?? [], answer);
    const evidenceCoverage = coverage(expected.evidenceFacts ?? [], events.filter(e => e.name === "agent.tool" && e.fields.status === "success").map(e => String(e.fields.result ?? "")).join("\n"));
    if (factCoverage !== null && factCoverage < 1) failures.push("missing_facts");
    if (citationCoverage !== null && citationCoverage < 1) failures.push("missing_citations");
    if (evidenceCoverage !== null && evidenceCoverage < 1) failures.push("missing_observed_evidence");
    const forbiddenMatches = (expected.forbidden ?? []).filter(p => new RegExp(p, "iu").test(answer)).length;
    if (forbiddenMatches) failures.push("forbidden_answer_content");
    const starts = events.filter(e => e.name === "agent.tool.started"), names = starts.map(e => toolName(e.fields));
    const required = expected.requiredTools ?? [], allowed = expected.allowedTools;
    const toolRecall = required.length ? required.filter(name => names.includes(name)).length / required.length : null;
    const toolPrecision = allowed && starts.length ? names.filter(name => allowed.includes(name)).length / starts.length : null;
    if (toolRecall !== null && toolRecall < 1) failures.push("missing_required_tools");
    if (toolPrecision !== null && toolPrecision < 1) failures.push("unexpected_tools");
    if (expected.maxToolCalls !== undefined && starts.length > expected.maxToolCalls) failures.push("excess_tool_calls");
    const ends = events.filter(e => e.name === "agent.tool");
    const argumentValidity = ends.length ? ends.filter(e => e.fields.code !== "INVALID_ARGUMENTS").length / ends.length : null;
    for (const code of expected.toolErrors ?? []) if (!ends.some(e => e.fields.code === code)) failures.push(`missing_tool_error:${code}`);
    for (const [field, event] of [["minRetries", "agent.retry"], ["minFallbacks", "agent.fallback"], ["minCompressions", "context.compressed"]] as const)
        if (events.filter(e => e.name === event).length < (expected[field] ?? 0)) failures.push(`missing_${field}`);
    for (const [field, event] of [["maxModelAttempts", "agent.model.started"], ["maxRetries", "agent.retry"], ["maxFallbacks", "agent.fallback"]] as const)
        if (expected[field] !== undefined && events.filter(e => e.name === event).length > expected[field]!) failures.push(`excess_${field}`);
    for (const [name, count] of Object.entries(expected.toolExecutions ?? {})) if ((executions[name] ?? 0) !== count) failures.push(`side_effect_count:${name}`);
    const policyCompliant = !failures.some(f => /error_code|forbidden|unexpected_tools|excess_tool|side_effect|missing_tool_error:ACCESS_DENIED/.test(f)) &&
        !(c.kind === "control" && expected.outcome !== "success" && outcome !== expected.outcome);
    return { passed: failures.length === 0, failures, factCoverage, evidenceCoverage, citationCoverage, toolPrecision, toolRecall, argumentValidity, forbiddenMatches, policyCompliant };
}
