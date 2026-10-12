import { createApp } from "../app.js";
import { loadConfig } from "../config/env.js";
import { logger } from "../common/logging/logger.js";
import { createDependencies } from "./container.js";

// 执行服务器启动逻辑
export function startServer() {
    const config = loadConfig();
    const dependencies = createDependencies({}, config);
    const app = createApp(config, dependencies);
    const server = app.listen(config.port, () => {
        logger.info("server.started", { port: config.port, environment: config.nodeEnv });
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
        logger.error("server.start_failed", { code: error.code ?? "UNKNOWN" });
        process.exitCode = 1;
    });

    let closing = false;
    function shutdown(signal: string) {
        if (closing) return;
        closing = true;
        logger.info("server.stopping", { signal });
        void dependencies.mcp.close();
        const timeout = setTimeout(() => {
            logger.error("server.shutdown_timeout");
            server.closeAllConnections();
            process.exit(1);
        }, config.shutdownTimeoutMs);
        timeout.unref();
        server.close((error) => {
            clearTimeout(timeout);
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
            if (error) {
                logger.error("server.shutdown_failed");
                process.exitCode = 1;
            } else {
                logger.info("server.stopped");
            }
        });
    }
    const onInterrupt = () => shutdown("SIGINT");
    const onTerminate = () => shutdown("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    return server;
}
