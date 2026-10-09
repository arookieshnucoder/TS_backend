export class HealthService {
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
