import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryPolicy, type RecoveryPolicy } from "./recovery.js";

export interface HarnessConfig {
    recovery: RecoveryPolicy;
    workspaceRoot?: string;
    maxCallsPerStep: number;
    toolTimeoutMs: number;
    toolOutputTokens: number;
}
export function loadHarnessConfig(env: NodeJS.ProcessEnv): HarnessConfig {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const number = (key: string, fallback: number, min: number, max: number) => {
        const value = env[key] === undefined ? fallback : Number(env[key]);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
        return value;
    };
    const enabled = env.AGENT_WORKSPACE_ENABLED ?? "true";
    if (enabled !== "true" && enabled !== "false") throw new Error("AGENT_WORKSPACE_ENABLED must be true or false");
    return {
        recovery: recoveryPolicy({ modelRetries: number("AGENT_MODEL_RETRIES", 2, 0, 5), toolRetries: number("AGENT_TOOL_RETRIES", 1, 0, 3),
            baseDelayMs: number("AGENT_RETRY_BASE_DELAY_MS", 250, 0, 30000), maxDelayMs: number("AGENT_RETRY_MAX_DELAY_MS", 3000, 0, 60000),
            modelAttemptTimeoutMs: number("AGENT_MODEL_ATTEMPT_TIMEOUT_MS", 30000, 1, 600000) }),
        workspaceRoot: enabled === "true" ? resolve(root, env.AGENT_WORKSPACE_ROOT ?? ".") : undefined,
        maxCallsPerStep: number("AGENT_MAX_CALLS_PER_STEP", 4, 1, 8),
        toolTimeoutMs: number("AGENT_TOOL_TIMEOUT_MS", 15000, 1, 120000),
        toolOutputTokens: number("AGENT_TOOL_OUTPUT_TOKENS", 2048, 128, 8192),
    };
}
