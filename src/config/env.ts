/**
 * 项目的基本环境配置，包括端口、前端监听地址、开发环境等。
 */

import "dotenv/config";


/**
 * 配置相关环境变量
 * 但是不建议自己的大模型ApiKey放在里面，这个自己做终端的环境变量来管理更安全。
 */
export interface AppConfig {
  // 后端端口
  port: number;
  // 前端监听端口
  frontendOrigin: string;
  // 开发环境
  nodeEnv: "development" | "test" | "production";
  // 接口超时时间
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 后端默认占用3000端口
  const rawPort = env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  // 本地默认只能用5173端口作为前端origin
  const frontendOrigin = env.FRONTEND_ORIGIN ?? "http://localhost:5173";
  let origin: URL;
  try {
    origin = new URL(frontendOrigin);
  } catch {
    throw new Error("FRONTEND_ORIGIN must be an HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== frontendOrigin) {
    throw new Error("FRONTEND_ORIGIN must be an HTTP(S) origin without a path");
  }
  // 开发环境，默认为 development
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error("NODE_ENV must be development, test or production");
  }

  // TODO: 未来加入更多环境变量配置，以及CI/CD相关的环境变量管理，按照业务需求加
  return { port, frontendOrigin, nodeEnv, shutdownTimeoutMs: 5000 };
}
