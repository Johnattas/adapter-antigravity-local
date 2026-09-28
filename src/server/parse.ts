/**
 * @fileoverview Log parsers and telemetry analysis helpers for the Antigravity local CLI execution.
 * Extracts specific execution failures, rate limits, session statuses, and authentication triggers from stdout/stderr.
 * 
 * @copyright Antigravity Adapter Contributors
 * @license MIT
 */

import { parseMultilineLines } from "../utils.js";

export interface ParsedAntigravityOutput {
  sessionId: string | null;
  response: string;
  errorMessage: string | null;
  permissionDeniedFailure: boolean;
  deniedActionCount: number;
  deniedActionTypes: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

function parseJsonLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "").trim();
  if (!line) return null;

  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseUsage(value: unknown): ParsedAntigravityOutput["usage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const readCount = (candidate: unknown): number | null => {
    const count = Number(candidate ?? 0);
    return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
  };
  const inputTokens = readCount(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = readCount(raw.output_tokens ?? raw.outputTokens);
  const cachedInputTokens = readCount(raw.cache_read_tokens ?? raw.cachedInputTokens);
  if (inputTokens === null || outputTokens === null || cachedInputTokens === null) return undefined;
  return { inputTokens, outputTokens, cachedInputTokens };
}

function readDeniedActionTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "desconhecida";
    const action = (entry as Record<string, unknown>).action;
    const normalized = typeof action === "string" ? action.trim() : "";
    return /^[a-z0-9_.:-]{1,64}$/i.test(normalized) ? normalized : "desconhecida";
  });
}

/**
 * Interpreta NDJSON e o objeto JSON final do agy sem devolver o envelope bruto
 * como mensagem do assistente. Saída textual simples permanece compatível.
 */
export function parseAntigravityOutput(stdout: string, stderr: string): ParsedAntigravityOutput {
  let sessionId: string | null = null;
  let response = "";
  let errorMessage: string | null = null;
  let usage: ParsedAntigravityOutput["usage"];
  const deniedActionTypes: string[] = [];
  const plainTextLines: string[] = [];
  let foundStructuredOutput = false;
  let permissionDeniedFailure = false;

  const consumeResult = (result: Record<string, unknown>) => {
    if (result.conversation_id) sessionId = String(result.conversation_id).trim() || sessionId;
    if (typeof result.response === "string" && result.response.trim()) response = result.response.trim();
    usage = parseUsage(result.usage) ?? usage;
    deniedActionTypes.push(...readDeniedActionTypes(result.denied_actions ?? result.deniedActions));
    if (String(result.status ?? "").toLowerCase() === "error") {
      errorMessage = String(result.error ?? result.response ?? "Falha na execução do Antigravity");
    }
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const data = parseJsonLine(rawLine);
    if (!data) {
      const line = rawLine.trim();
      if (line) plainTextLines.push(line);
      continue;
    }

    foundStructuredOutput = true;
    if (data.event === "init" && data.conversation_id) {
      sessionId = String(data.conversation_id).trim() || sessionId;
    }
    if (data.event === "step_update" && data.step_update && typeof data.step_update === "object") {
      const update = data.step_update as Record<string, unknown>;
      if (!sessionId && update.conversation_id) sessionId = String(update.conversation_id).trim();
      if (update.step_type === "agent_response" && typeof update.text_delta === "string") {
        response += update.text_delta;
      }
      usage = parseUsage(update.usage) ?? usage;
    }
    if (data.event === "result" && data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
      consumeResult(data.result as Record<string, unknown>);
    } else if ("status" in data || "response" in data || "denied_actions" in data || "deniedActions" in data) {
      consumeResult(data);
    }
  }

  if (!foundStructuredOutput && !response) response = plainTextLines.join("\n");
  if (!errorMessage && !response.trim() && deniedActionTypes.length > 0) {
    permissionDeniedFailure = true;
    const tipos = [...new Set(deniedActionTypes)].join(", ");
    errorMessage = `Antigravity não produziu resposta porque ${deniedActionTypes.length} ação(ões) foi(ram) negada(s)${tipos ? ` (${tipos})` : ""}. Revise as permissões ou ajuste a tarefa.`;
  }
  if (!errorMessage && /(?:error|fatal|exception)\s*:/i.test(stderr)) {
    errorMessage = stderr.trim();
  }

  return {
    sessionId,
    response: response.trim(),
    errorMessage,
    permissionDeniedFailure,
    deniedActionCount: deniedActionTypes.length,
    deniedActionTypes: [...new Set(deniedActionTypes)],
    usage,
  };
}

/**
 * Combines and normalizes stdout and stderr into a single list of trimmed, non-empty lines.
 * Reusable utility to avoid duplicate output merging logic.
 *
 * @param stdout - The stdout string output.
 * @param stderr - The stderr string output.
 * @returns An array of sanitized message lines.
 */
function combineAndCleanLines(stdout: string, stderr: string): string[] {
  return parseMultilineLines(`${stdout}\n${stderr}`);
}

/** Regex pattern to identify CLI authentication failures or key missing errors. */
const AGY_AUTH_REQUIRED_RE = /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?agy\s+auth(?:\s+login)?`?\s+first)/i;

/** Regex pattern to identify API quota exhaustions, billing issues, or rate limits. */
const AGY_QUOTA_EXHAUSTED_RE = /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details)/i;

/**
 * Checks whether the CLI process execution failed because the requested conversation
 * session was unknown, deleted, or otherwise not found.
 *
 * @param stdout - The process stdout stream content.
 * @param stderr - The process stderr stream content.
 * @returns True if an unknown session error signature is matched.
 */
export function isAntigravityUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = combineAndCleanLines(stdout, stderr).join("\n");

  return /unknown\s+conversation|conversation\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume/i.test(
    haystack,
  );
}

/**
 * Probes stdout/stderr output lines for missing authentication configurations.
 * Allows the orchestrator to automatically flag required interactive auth.
 *
 * @param input - Object containing stdout and stderr streams.
 * @returns Object indicating if authentication is required.
 */
export function detectAntigravityAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  const requiresAuth = messages.some((line) => AGY_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

/**
 * Checks if the Antigravity execution failed because of billing quotas, 
 * rate-limits (HTTP 429), or API resource limit exhaustion.
 *
 * @param input - Object containing stdout and stderr streams.
 * @returns Object indicating if quota is exhausted.
 */
export function detectAntigravityQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): { exhausted: boolean } {
  const messages = combineAndCleanLines(input.stdout, input.stderr);
  const exhausted = messages.some((line) => AGY_QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

/**
 * Detects if the run hit the safety maximum agent turn thresholds.
 * Evaluates the exit code (typically code 53) or searches stderr logs.
 *
 * @param exitCode - Optional exit code returned by the command execution.
 * @param stderr - Optional error outputs.
 * @returns True if safety thresholds or maximum turns limit was crossed.
 */
export function isAntigravityTurnLimitResult(
  exitCode?: number | null,
  stderr?: string
): boolean {
  if (exitCode === 53) {
    return true;
  }
  
  if (stderr) {
    const lowerStderr = stderr.toLowerCase();
    if (lowerStderr.includes("turn_limit") || lowerStderr.includes("max_turns")) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a concise error description representing the first failure log line.
 * Useful to present user-friendly error boundaries to the Paperclip Web UI.
 *
 * @param stdout - The stdout string output.
 * @param stderr - The stderr string output.
 * @returns A formatted failure message, or null if no logs exist.
 */
export function describeAntigravityFailure(stdout: string, stderr: string): string | null {
  const lines = parseMultilineLines(`${stderr}\n${stdout}`);
  if (lines.length === 0) {
    return null;
  }
  return `Antigravity run failed: ${lines[0]}`;
}
