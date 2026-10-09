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
