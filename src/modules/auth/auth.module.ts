import { Router, type Request, type RequestHandler } from "express";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthService } from "./auth.service.js";
import { identity } from "./identity.js";

const cookieName = "songjian_sso";
function readToken(request: Request): string | undefined {
    const value = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
/** JSON + custom header prevents browser form CSRF, including requests without Origin. */
export function authWriteAccess(origin: string): RequestHandler {
    return (request, _response, next) => {
        if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
        if ((request.get("Origin") && request.get("Origin") !== origin) || request.get("Sec-Fetch-Site") === "cross-site" ||
            request.get("X-Requested-With") !== "XMLHttpRequest")
            return next(new AppError(403, "AUTH_ORIGIN_FORBIDDEN", "登录操作来源无效，请刷新页面后重试。"));
        if (!request.is("application/json")) return next(new AppError(415, "AUTH_JSON_REQUIRED", "操作只接受 application/json。"));
        next();
    };
}
export function requireAuth(service: AuthService): RequestHandler {
    return async (request, response, next) => {
        const user = await service.current(readToken(request));
        if (!user) throw new AppError(401, "AUTH_REQUIRED", "请先登录。");
        response.locals.user = user;
        response.setHeader("Cache-Control", "no-store");
        identity.run(user, next);
    };
}
export const requireAdmin: RequestHandler = (_request, response, next) => {
    if (response.locals.user?.role !== "admin") return next(new AppError(403, "AUTH_ADMIN_REQUIRED", "此功能仅限管理员使用。"));
    next();
};
export function createAuthModule(service: AuthService, origin: string): Router {
    const router = Router();
    const cookie = { httpOnly: true, secure: service.config.secureCookie, sameSite: "lax" as const, path: "/api" };
    router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
    router.use(authWriteAccess(origin));
    // Bounded process-local limiter. A distributed limiter can replace this middleware later.
    const attempts = new Map<string, { count: number; until: number }>();
    const limit: RequestHandler = (request, response, next) => {
        const now = Date.now();
        for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
        const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
        let entry = attempts.get(key);
        if (!entry) {
            if (attempts.size >= 10000) return next(new AppError(429, "AUTH_RATE_LIMITED", "请求过多，请稍后重试。"));
            entry = { count: 0, until: now + 15 * 60 * 1000 }; attempts.set(key, entry);
        }
        if (++entry.count > 20) {
            response.setHeader("Retry-After", Math.ceil((entry.until - now) / 1000));
            return next(new AppError(429, "AUTH_RATE_LIMITED", "尝试次数过多，请 15 分钟后重试。"));
        }
        next();
    };
    router.get("/session", async (request, response) => response.json({ data: { user: await service.current(readToken(request)) } }));
    for (const action of ["register", "login"] as const) {
        router.post(`/${action}`, limit, async (request, response) => {
            const { user, token } = await service[action](request.body, readToken(request));
            response.cookie(cookieName, token, { ...cookie, maxAge: service.config.sessionTtlSeconds * 1000 });
            response.status(action === "register" ? 201 : 200).json({ data: { user } });
        });
    }
    router.post("/logout", async (request, response) => {
        await service.logout(readToken(request));
        response.clearCookie(cookieName, cookie);
        response.json({ data: { user: null } });
    });
    return router;
}
