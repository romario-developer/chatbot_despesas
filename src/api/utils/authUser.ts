import { AuthedRequest } from "../middleware/auth";
import { API_TELEGRAM_ID } from "../../utils/systemUsers";

export function resolveAuthUserId(req: AuthedRequest): string {
  return req.auth?.sub === "admin" ? API_TELEGRAM_ID : req.auth?.sub ?? API_TELEGRAM_ID;
}
