import type { ChatSession, ChatMessage } from "../chat/entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../chat/repository/chat-session.repository.js";
import type { AgentModel } from "../agent/model.js";
import type { Logger } from "../../common/logging/logger.js";
import type { ContextConfig } from "./context/config.js";
import type { MemorySearch } from "./context/contracts.js";
import type { AgentResult } from "../agent/contracts.js";
import { AskAgent } from "../agent/ask-agent.js";
import { TokenBudget } from "./context/tokens.js";
import { ContextCompressor, SessionTitleGenerator, transcript, validTitle } from "./context/services.js";
import { ContextBuilder } from "./context-builder.js";
import { createMemoryTools } from "./memory-tools.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { abortable } from "./cancellation.js";

export interface HarnessOptions {
  workspaceRoot?: string;
  excludedPaths?: string[];
  maxCallsPerStep?: number;
  toolTimeoutMs?: number;
  toolOutputTokens?: number;
  generateTitles?: boolean;
}
export interface AgentRunner {
  run(session: ChatSession, current: ChatMessage, signal?: AbortSignal): Promise<{ content: string }>;
  titleFor(session: ChatSession, signal?: AbortSignal): Promise<string>;
}

/** Composition root for one Ask run. The workflow never imports storage, tools or LangChain. */
export class AgentHarness implements AgentRunner {
  private readonly tokens: TokenBudget;
  private readonly compression: ContextCompressor;
  private readonly title: SessionTitleGenerator;
  constructor(private readonly repository: ChatSessionRepository, private readonly model: AgentModel,
    private readonly searchFactory: () => MemorySearch, private readonly config: ContextConfig, private readonly logger: Logger,
    private readonly options: HarnessOptions = {}) {
    this.tokens = new TokenBudget(config);
    this.compression = new ContextCompressor(model, this.tokens, config);
    this.title = new SessionTitleGenerator(model, this.tokens, config);
  }
  async run(session: ChatSession, current: ChatMessage, signal?: AbortSignal): Promise<AgentResult> {
    const started = Date.now();
    const event = (name: string, fields: Record<string, unknown> = {}) => this.logger.info(name,
      { sessionId: session.id, requestId: session.modelRequestId ?? current.id, ...fields });
    event("agent.started");
    try {
      return await abortable(async () => {
        const snapshot = structuredClone(session);
        const builder = new ContextBuilder(snapshot.messages, structuredClone(current), this.config, this.tokens, this.compression, event, !!this.options.workspaceRoot);
        const registry = new ToolRegistry(this.tokens, this.options.toolOutputTokens ?? 2048, this.options.toolTimeoutMs ?? 15000, event);
        const candidates = structuredClone((await this.repository.findAll()).filter(s => s.id !== session.id && s.messages.length)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 10));
        for (const tool of createMemoryTools(snapshot, candidates, this.searchFactory(), this.compression, this.config)) registry.register(tool);
        if (this.options.workspaceRoot) for (const tool of createWorkspaceTools(this.options.workspaceRoot, this.options.excludedPaths)) registry.register(tool);
        const result = await new AskAgent().run({
          tools: registry.definitions(), maxToolSteps: this.config.maxToolSteps, maxCallsPerStep: this.options.maxCallsPerStep ?? 4,
          prepare: (rounds, final, signal) => abortable(() => builder.build(rounds, final ? [] : registry.definitions(), final, signal), signal),
          complete: (messages, tools, signal) => abortable(() => this.model.turn(messages, tools, signal), signal),
          execute: (call, signal) => registry.execute(call, signal), event,
        }, signal);
        event("agent.completed", { modelTurns: result.modelTurns, toolCalls: result.toolCalls, durationMs: Date.now() - started });
        return result;
      }, signal);
    } catch (error) {
      event("agent.failed", { cancelled: signal?.aborted ?? false, durationMs: Date.now() - started });
      throw error;
    }
  }
  async titleFor(session: ChatSession, signal?: AbortSignal): Promise<string> {
    if (this.options.generateTitles === false) return session.title;
    const turns = session.messages.filter(m => m.role === "user").length;
    let title = session.title;
    if (turns > 0 && turns <= 5) {
      try { title = await abortable(() => this.title.execute(session, signal), signal); }
      catch {
        this.logger.error("context.title_failed", { sessionId: session.id });
        if (!validTitle(title)) title = /\p{Script=Han}/u.test(transcript(session.messages.slice(-2))) ? "新的对话主题正在整理中" : "New conversation topic awaiting a title";
      }
    }
    return title;
  }
}
