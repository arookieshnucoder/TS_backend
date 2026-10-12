import assert from "node:assert/strict";
import test from "node:test";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { loadConfig } from "../src/config/env.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { LocalMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import type { AgentModel } from "../src/modules/agent/model.js";

const config = loadConfig({ AGENT_WORKSPACE_ENABLED: "false", LLM_MAX_INPUT_TOKENS: "4096" });
const logger = { info() {}, error() {} };
const search = () => new LocalMemorySearch(new TokenBudget(config.context));

test("switching models in the same stored session preserves role/content history", async () => {
    const repository = new InMemoryChatSessionRepository();
    const first = new ChatSessionService(repository, createChatAgent(repository,
        { async turn() { return { content: "I recorded project ORCHID-42.", toolCalls: [] }; } }, search,
        config.context, logger, { tools: async () => [], title: async s => s.title }));
    const session = await first.create("project", "model-switch");
    await first.send(session.id, "Our project code is ORCHID-42.");
    const second = new ChatSessionService(repository, createChatAgent(repository, { async turn(messages) {
        assert.ok(messages.some(m => m.role === "user" && m.content.includes("ORCHID-42")));
        assert.ok(messages.some(m => m.role === "assistant" && m.content.includes("ORCHID-42")));
        return { content: "The project code is ORCHID-42.", toolCalls: [] };
    } }, search, config.context, logger, { tools: async () => [], title: async s => s.title }));
    const completed = await second.send(session.id, "What is the project code?");
    assert.equal(completed.sessionStatus, "finished");
    assert.equal(completed.messages.length, 4);
    assert.equal(completed.messages.at(-1)!.content, "The project code is ORCHID-42.");
});

test("shared memory summaries follow the active recovery model and emit model usage events", async () => {
    const repository = new InMemoryChatSessionRepository();
    let primarySummaries = 0, backupSummaries = 0;
    const primary: AgentModel = { async turn(messages) {
        if (messages[0]?.content.startsWith("Summarize")) primarySummaries++;
        throw Object.assign(new Error("primary unavailable"), { status: 503 });
    } };
    const backup: AgentModel = { async turn(messages) {
        if (messages[0]?.content.startsWith("Summarize")) {
            backupSummaries++;
            return { content: "Project ORCHID-42 belongs to Mira.", toolCalls: [], usage: { inputTokens: 100, outputTokens: 12 } };
        }
        if (messages.at(-1)?.role === "tool") {
            assert.match(messages.at(-1)!.content, /ORCHID-42/);
            return { content: "Project ORCHID-42 belongs to Mira.", toolCalls: [] };
        }
        return { content: "", toolCalls: [{ id: "memory", name: "search_shared_memory", arguments: { query: "project" } }] };
    } };
    const agent = createChatAgent(repository, primary, search, config.context, logger, {
        title: async s => s.title, recovery: { modelRetries: 0, toolRetries: 0 }, fallbackModels: [{ name: "backup", model: backup }],
    });
    const service = new ChatSessionService(repository, agent);
    const current = await service.create("current", "current");
    const prior = await service.create("project", "prior");
    prior.messages = [{ id: "old", role: "user", content: "Project ORCHID-42 belongs to Mira. ".repeat(60) }];
    await repository.save(prior);
    const events: { name: string; fields?: Record<string, unknown> }[] = [];
    const result = await agent.run(current, { id: "q", role: "user", content: "Search project memories." }, undefined,
        { runId: "memory-recovery", event(name, fields) { events.push({ name, fields }); } });
    assert.match(result.content, /ORCHID-42/);
    assert.equal(primarySummaries, 0);
    assert.equal(backupSummaries, 1);
    assert.equal(events.filter(e => e.name === "agent.fallback").length, 1);
    assert.equal(events.filter(e => e.name === "agent.model.started").length, 4);
    assert.ok(events.some(e => e.name === "agent.model.completed" && e.fields?.usage));
    assert.equal(events.find(e => e.name === "agent.tool")!.fields!.status, "success");
});
