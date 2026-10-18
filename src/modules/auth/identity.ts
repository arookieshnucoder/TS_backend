import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthUser } from "./contracts.js";

/** Request identity follows async work, including the agent's history retrieval. */
export const identity = new AsyncLocalStorage<AuthUser>();
