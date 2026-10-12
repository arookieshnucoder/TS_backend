import { Router } from "express";
import { AppError } from "../../common/errors/app-error.js";
import { adminAccess } from "../mcp/mcp.module.js";
import type { RunTraceStore } from "./run-trace.js";

export function createObservabilityModule(store: RunTraceStore | undefined, origin: string, token?: string, requireToken = false): Router {
    const router = Router();
    router.use(adminAccess(origin, token, requireToken));
    router.use((_request, _response, next) => next(store ? undefined : new AppError(503, "TRACE_DISABLED", "后端未启用运行记录。")));
    router.get("/sessions/:id/runs", async (request, response) => {
        const rawLimit = request.query.limit ?? "20";
        const before = request.query.before;
        if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit) || (before !== undefined && typeof before !== "string")) throw new AppError(400, "TRACE_INVALID_QUERY", "运行记录查询参数无效。");
        response.json({ data: await store!.list(String(request.params.id), Number(rawLimit), before as string | undefined) });
    });
    router.get("/sessions/:id/runs/:runId", async (request, response) => response.json({ data: await store!.get(String(request.params.id), String(request.params.runId)) }));
    return router;
}
