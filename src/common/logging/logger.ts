/** 结构化日志接口，事件名与字段分开传入，方便替换日志实现。 */
export interface Logger {
    info(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
}

export const logger: Logger = {
    info(event, fields = {}) {
        console.log(JSON.stringify({ ...fields, level: "info", event, timestamp: new Date().toISOString() }));
    },
    error(event, fields = {}) {
        console.error(JSON.stringify({ ...fields, level: "error", event, timestamp: new Date().toISOString() }));
    }
};
