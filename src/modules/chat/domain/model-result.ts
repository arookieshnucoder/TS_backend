export function isValidModelResult(result: unknown): result is string {
  return typeof result === "string" && result.trim().length > 0;
}
