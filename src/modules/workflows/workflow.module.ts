import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AppConfig } from "../../config/env.js";
import { AppError } from "../../common/errors/app-error.js";
import { requireAdmin } from "../auth/auth.module.js";
import { nodeDefinitions } from "./definition.js";
import { runtimeSnapshot, workflowTemplate } from "./templates.js";
import type { WorkflowStore } from "./workflow.store.js";

export function workflowModule(store: WorkflowStore | undefined, config: AppConfig): Router {
    const router = Router();
    router.use(requireAdmin);
    router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(store ? undefined : new AppError(503, "WORKFLOW_UNAVAILABLE", "工作流数据库未配置。")); });
    const revision = (value: unknown) => {
        if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
        if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AppError(400, "WORKFLOW_INVALID_REVISION", "修订号无效。");
        return Number(value);
    };
    router.get("/catalog", (_request, response) => response.json({ data: { nodeDefinitions, subjects: ["math", "chinese", "english", "general"] } }));
    router.get("/", async (_request, response) => response.json({ data: await store!.list() }));
    router.post("/", async (request, response) => response.status(201).json({ data: await store!.create(randomUUID(), request.body, response.locals.user.username) }));
    router.get("/template/:subject", (request, response) => {
        const subject = String(request.params.subject);
        if (!["math", "chinese", "english", "general"].includes(subject)) throw new AppError(400, "WORKFLOW_INVALID_SUBJECT", "分类无效。");
        response.json({ data: workflowTemplate(subject as "math") });
    });
    router.get("/:id", async (request, response) => {
        const value = await store!.get(String(request.params.id));
        response.json({ data: { ...value, runtime: runtimeSnapshot(config, value.subject) } });
    });
    router.put("/:id", async (request, response) => {
        const { expectedRevision, ...input } = request.body ?? {};
        response.json({ data: await store!.save(String(request.params.id), input, revision(expectedRevision), response.locals.user.username) });
    });
    router.post("/:id/publish", async (request, response) => response.json({ data: await store!.publish(String(request.params.id), revision(request.body?.expectedRevision), response.locals.user.username) }));
    router.get("/:id/versions", async (request, response) => response.json({ data: await store!.versions(String(request.params.id)) }));
    router.get("/:id/versions/:revision", async (request, response) => response.json({ data: await store!.version(String(request.params.id), revision(request.params.revision)) }));
    return router;
}
