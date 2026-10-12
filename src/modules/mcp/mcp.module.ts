import { timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { AppError } from "../../common/errors/app-error.js";
import { object } from "./mcp-config.js";
import type { McpManager } from "./mcp-manager.js";

export function adminAccess(origin: string, token?: string, requireToken = false): RequestHandler {
    return (request, _response, next) => {
        const actualOrigin = request.get("Origin");
        if (actualOrigin && actualOrigin !== origin) return next(new AppError(403, "ADMIN_FORBIDDEN", "管理接口不接受该来源。"));
        if (requireToken && !token) return next(new AppError(503, "ADMIN_TOKEN_REQUIRED", "生产环境管理功能需要在后端设置 MCP_ADMIN_TOKEN。"));
        if (token) {
            const supplied = Buffer.from(request.get("Authorization")?.replace(/^Bearer /, "") ?? "");
            const expected = Buffer.from(token);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return next(new AppError(401, "ADMIN_UNAUTHORIZED", "请填写管理员令牌。"));
        } else if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
            return next(new AppError(403, "ADMIN_LOCAL_ONLY", "远程管理需要设置 MCP_ADMIN_TOKEN。"));
        }
        if (!["GET", "HEAD"].includes(request.method) && !request.is("application/json")) return next(new AppError(415, "ADMIN_JSON_REQUIRED", "管理操作只接受 application/json。"));
        next();
    };
}
export function createMcpModule(manager: McpManager, origin: string, token?: string, requireToken = false): Router {
    const router = Router();
    router.use(adminAccess(origin, token, requireToken));
    router.get("/servers", async (_request, response) => response.json({ data: await manager.list() }));
    router.post("/servers/import", async (request, response) => response.status(201).json({ data: await manager.import(request.body) }));
    router.patch("/servers/:id", async (request, response) => {
        if (!object(request.body) || !Object.keys(request.body).length || Object.keys(request.body).some(k => !["enabled", "allowMutations"].includes(k) || typeof request.body[k] !== "boolean"))
            throw new AppError(400, "MCP_INVALID_CONFIG", "只接受 enabled 和 allowMutations 布尔字段。");
        response.json({ data: await manager.update(String(request.params.id), request.body) });
    });
    router.post("/servers/:id/test", async (request, response) => response.json({ data: await manager.test(String(request.params.id)) }));
    return router;
}
