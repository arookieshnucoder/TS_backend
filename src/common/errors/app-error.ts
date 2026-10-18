/** 携带 HTTP 状态码和业务错误码的异常，由统一错误处理器转换成响应。 */
export class AppError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "AppError";
    }
}
