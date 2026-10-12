import { ToolInputError, type RegisteredTool } from "./tool-contracts.js";

/** 一个参数的模型说明与运行时解析必须一起定义，避免 schema 与校验规则分离。 */
export interface ToolParameter<T> {
    schema: Record<string, unknown>;
    parse(value: unknown, name: string): T;
}

/** 必填非空字符串；保留原始内容，不擅自 trim 用户的搜索词或路径。 */
export function stringParameter(maxLength: number, description?: string): ToolParameter<string> {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new TypeError("Invalid string maxLength");
    return {
        schema: { type: "string", minLength: 1, maxLength, ...(description ? { description } : {}) },
        parse(value, name) {
            if (typeof value !== "string" || !value.trim() || value.length > maxLength)
                throw new ToolInputError(`${name} must be a non-empty string of at most ${maxLength} characters`);
            return value;
        },
    };
}

/** 必填安全整数；边界同时用于模型 schema 和服务端校验。 */
export function integerParameter(minimum: number, maximum = Number.MAX_SAFE_INTEGER): ToolParameter<number> {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum)
        throw new TypeError("Invalid integer bounds");
    return {
        schema: { type: "integer", minimum, maximum },
        parse(value, name) {
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
                throw new ToolInputError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
            return value;
        },
    };
}

type Parameters = Record<string, ToolParameter<unknown>>;
export type ToolInput<P extends Parameters> = {
    [K in keyof P]: P[K] extends ToolParameter<infer T> ? T : never;
};

export interface ReadOnlyToolOptions<P extends Parameters> {
    name: string;
    description: string;
    /** 当前参数均为必填；额外字段会被拒绝。新参数类型可实现 ToolParameter<T>。 */
    parameters: P;
    /** 可选的跨字段业务校验：仅校验，不修改参数、不做 I/O；失败抛 ToolInputError。 */
    validate?(input: ToolInput<P>): void;
    /** 只读业务逻辑；返回文本或 JSON 字符串，并向下游传递取消信号。 */
    execute(input: ToolInput<P>, signal?: AbortSignal): Promise<string>;
}

/**
 * 声明只读工具的统一入口，封装 readonly、definition 和参数校验。
 * 新工具只需声明名称、用途、参数和执行函数，再加入业务工具工厂返回的数组。
 * 只读标记是契约，不能替代实现中的权限检查；超时、日志、输出截断由 ToolRegistry 负责。
 *
 * @example
 * defineReadOnlyTool({
 *   name: "lookup", description: "按关键词查询资料",
 *   parameters: { query: stringParameter(500) },
 *   execute: ({ query }, signal) => service.search(query, signal),
 * });
 */
export function defineReadOnlyTool<P extends Parameters>(options: ReadOnlyToolOptions<P>): RegisteredTool {
    if (!options.name.trim() || !options.description.trim()) throw new TypeError("Tool name and description are required");
    const entries = Object.entries(options.parameters);
    const allowed = new Set(entries.map(([name]) => name));
    function parse(input: Record<string, unknown>): ToolInput<P> {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolInputError("Expected a JSON object");
        if (Object.keys(input).some(name => !allowed.has(name)))
            throw new ToolInputError(`Allowed fields: ${[...allowed].join(", ")}`);
        const parsed = Object.fromEntries(entries.map(([name, parameter]) =>
            [name, parameter.parse(Object.hasOwn(input, name) ? input[name] : undefined, name)])) as ToolInput<P>;
        options.validate?.(parsed);
        return parsed;
    }
    return {
        readonly: true,
        idempotent: true,
        source: { type: "custom" },
        definition: {
            name: options.name,
            description: options.description,
            parameters: {
                type: "object",
                properties: Object.fromEntries(entries.map(([name, parameter]) => [name, structuredClone(parameter.schema)])),
                required: [...allowed],
                additionalProperties: false,
            },
        },
        validate(input) { parse(input); },
        async execute(input, signal) {
            signal?.throwIfAborted();
            // 执行入口也校验，直接调用工具时不会绕过约束；解析和校验必须无副作用。
            return options.execute(parse(input), signal);
        },
    };
}
