import { createApp } from "../app.js";
import { loadConfig } from "../config/env.js";
import { logger } from "../common/logging/logger.js";
import { createDependencies } from "./container.js";
import { closeApplicationResources } from "./lifecycle.js";

// 执行服务器启动逻辑
export async function startServer() {
    const config = loadConfig();
    const dependencies = createDependencies({}, config);
    try { await dependencies.auth?.initialize(); await dependencies.solutionSkills?.store.initialize(); await dependencies.workflows?.initialize(); }
    catch {
        logger.error("server.auth_database_unavailable");
        await closeApplicationResources(dependencies);
        process.exitCode = 1;
        return;
    }
    const app = createApp(config, dependencies);
    const server = app.listen(config.port, () => {
        logger.info("server.started", { port: config.port, environment: config.nodeEnv });
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
        logger.error("server.start_failed", { code: error.code ?? "UNKNOWN" });
        process.exitCode = 1;
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        void closeResources();
    });

    // Startup errors and shutdown signals can race; every resource is closed once.
    let cleanup: ReturnType<typeof closeApplicationResources> | undefined;
    const closeResources = () => cleanup ??= closeApplicationResources(dependencies, app.locals.chatBackground);
    let closing = false;
    function shutdown(signal: string) {
        if (closing) return;
        closing = true;
        logger.info("server.stopping", { signal });
        const timeout = setTimeout(() => {
            logger.error("server.shutdown_timeout");
            server.closeAllConnections();
            process.exit(1);
        }, config.shutdownTimeoutMs);
        timeout.unref();
        server.close(async (error) => {
            const results = await closeResources();
            clearTimeout(timeout);
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
            if (error || results.some(result => result.status === "rejected")) {
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
