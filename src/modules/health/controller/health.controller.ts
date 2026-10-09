import type { RequestHandler } from "express";
import type { HealthService } from "../service/health.service.js";

export class HealthController {
  constructor(private readonly service: HealthService) {}

  readonly check: RequestHandler = (_request, response) => {
    response.json(this.service.check());
  };
}
