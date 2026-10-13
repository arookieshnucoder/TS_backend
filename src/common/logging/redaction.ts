const sensitive = /password|passwd|secret|credential|authorization|cookie|api.?key|access.?token|refresh.?token|^(token|env|headers)$/i;
export function environmentSecrets(): string[] {
    return Object.entries(process.env).filter(([key, value]) => sensitive.test(key) && value && value.length >= 4).map(([, value]) => value!);
}
/** Bounded diagnostic previews, never full prompts or provider exceptions. */
export function redact(value: unknown, secrets: string[] = environmentSecrets(), limits: { maxStringLength?: number; maxCharacters?: number } = {}): unknown {
    const known = [...new Set(secrets.filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
    const seen = new Set<object>();
    let nodes = 0, remaining = limits.maxCharacters ?? 8192;
    function visit(value: unknown, depth: number): unknown {
        if (++nodes > 256 || remaining <= 0 || depth > 5) return "[TRUNCATED]";
        if (typeof value === "string") {
            let text = value;
            for (const secret of known) text = text.split(secret).join("[REDACTED]");
            text = text.replace(/\bBearer\s+[^\s"',}\]]+/gi, "Bearer [REDACTED]")
                .replace(/\bBasic\s+[A-Za-z0-9+/]+={0,2}(?=["',}\]\r\n]|$)/gi, "Basic [REDACTED]")
                .replace(/((?:authorization|cookie|set-cookie)["']?\s*[=:]\s*["']?)[^\r\n"'}]+/gi, "$1[REDACTED]")
                .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
                .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
                .replace(/((?:api[_-]?key|access[_-]?token|password|secret|token)["']?\s*[=:]\s*["']?)[^\s"',}&]+/gi, "$1[REDACTED]");
            const max = Math.min(limits.maxStringLength ?? 1024, remaining); remaining -= Math.min(text.length, max);
            return text.length > max ? `${text.slice(0, max)}…[TRUNCATED]` : text;
        }
        if (value === null || typeof value === "boolean" || typeof value === "number") { remaining -= 16; return value; }
        if (!value || typeof value !== "object") return undefined;
        if (seen.has(value)) return "[CIRCULAR]";
        seen.add(value);
        if (Array.isArray(value)) return value.slice(0, 30).map(item => visit(item, depth + 1));
        return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) =>
            [key.slice(0, 100), sensitive.test(key) ? "[REDACTED]" : visit(item, depth + 1)]));
    }
    return visit(value, 0);
}
