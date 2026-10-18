import type { RequestHandler } from "express";
import type { HealthService } from "../service/health.service.js";

/** 健康检查的 HTTP 入口，返回服务存活状态。 */
export class HealthController {
    constructor(private readonly service: HealthService) { }

    readonly check: RequestHandler = (_request, response) => {
        const result = this.service.check();
        response.status(result.httpStatusCode).json(result);
    };
}
