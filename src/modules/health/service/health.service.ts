import { HttpStatus } from "../../../common/http/http-status.js";
/** 提供服务健康状态，供探针检查和启动验证使用。 */
export class HealthService {
    check(): { httpStatusCode: typeof HttpStatus.OK } {
        return { httpStatusCode: HttpStatus.OK };
    }
}
