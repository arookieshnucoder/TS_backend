import { Router } from "express";
import { HealthController } from "./controller/health.controller.js";
import { HealthService } from "./service/health.service.js";

export function createHealthModule(): Router {
    const controller = new HealthController(new HealthService());
    const router = Router();
    router.get("/", controller.check);
    return router;
}
