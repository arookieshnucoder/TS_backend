import { HttpStatus } from "../../../common/http/http-status.js";
export class HealthService {
    check(): { httpStatusCode: typeof HttpStatus.OK } {
        return { httpStatusCode: HttpStatus.OK };
    }
}
