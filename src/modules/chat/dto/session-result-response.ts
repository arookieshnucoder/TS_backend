import type { Response } from "express";
import type { ChatSession } from "../entity/chat-session.entity.js";
import { HttpStatus } from "../../../common/http/http-status.js";
import { toSessionResponse } from "./session-response.dto.js";

// The public send endpoint and internal result endpoint return the same REST contract.
export function sendSessionResult(response: Response, session: ChatSession): void {
  const httpStatusCode = session.sessionStatus === "finished" ? HttpStatus.OK : HttpStatus.BAD_REQUEST;
  response.status(httpStatusCode).json({
    data: toSessionResponse(session), httpStatusCode, error: session.sessionError,
    requestId: response.locals.requestId,
  });
}
