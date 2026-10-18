import type { AgentMessage, AgentTurn, ToolDefinition } from "./contracts.js";
/** 模型供应商连接配置，包含模型名、地址、凭据和请求超时。 */
export interface LlmConfig { llmApiKey?: string; llmModel: string; llmBaseUrl?: string; llmTimeoutMs: number; }

/** 可纠正的供应商协议错误；不携带原始响应，避免把凭据或推理文本写进日志。 */
export class ModelProtocolError extends Error {
    constructor(readonly code: "INVALID_TOOL_CALLS" | "INVALID_RESPONSE") {
        super(code);
        this.name = "ModelProtocolError";
    }
}

/** 统一模型调用接口，通用及学科工作流都通过它获取下一轮回复。 */
export interface AgentModel {
  /**
   * 执行一次代理模型的对话轮次。
   * @param messages 当前对话的消息列表。
   * @param tools 可用的工具定义列表。
   * @param signal 可选的中止信号，用于取消请求。
   * @param maxOutputTokens 可选的最大输出令牌数。
   * @returns 返回代理模型生成的对话轮次结果。
   */
  turn(messages: AgentMessage[],
       tools: ToolDefinition[], 
       signal?: AbortSignal, 
       maxOutputTokens?: number): Promise<AgentTurn>;
}
