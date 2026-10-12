import type { AgentMessage, AgentTurn, ToolDefinition } from "./contracts.js";

/** One provider protocol for agent decisions and harness-internal text generation. */
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
