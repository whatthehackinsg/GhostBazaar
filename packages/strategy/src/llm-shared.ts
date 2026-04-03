export const DEFAULT_MODEL = "claude-sonnet-4-6"
export const MAX_SANITIZED_INPUT_LENGTH = 200
export const LLM_MAX_RESPONSE_TOKENS = 256

export function sanitizeInput(s: string): string {
  return s.replace(/[\n\r]/g, " ").slice(0, MAX_SANITIZED_INPUT_LENGTH)
}
