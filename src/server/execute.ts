import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterAgent,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  joinPromptSections,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  sanitizeInheritedPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { firstNonEmptyLine } from "../utils.js";
import { parseAntigravityOutput } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE = [
  "You are agent {{agent.id}} ({{agent.name}}). Continue the Paperclip conversation described in the supplied wake payload.",
  "Respond to the user's latest message before doing unrelated exploration. Use issue-thread interactions when structured questions or explicit confirmation are required.",
  "Use the injected PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_TASK_ID and PAPERCLIP_RUN_ID for Paperclip operations.",
  "Never discover Paperclip endpoints by reading its source code, read instance secrets, or construct authentication tokens manually. If a required runtime binding is absent, stop promptly and report the missing binding.",
  "Do not treat a conversation as an ordinary execution task. Respect planning/read-only gates, explicit approvals, budget, pause/cancel, and company boundaries.",
].join("\n");

function runtimeTaskId(context: Record<string, unknown>): string {
  const issue = parseObject(context.paperclipIssue);
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  return (
    asString(context.taskId, "").trim() ||
    asString(context.issueId, "").trim() ||
    asString(issue.id, "").trim() ||
    asString(wakeIssue.id, "").trim()
  );
}

function applyTrustedPaperclipRuntimeEnv(
  env: Record<string, string>,
  runId: string,
  agent: AdapterAgent,
  context: Record<string, unknown>,
  authToken: string | null | undefined,
): void {
  Object.assign(env, buildPaperclipEnv(agent));
  env.PAPERCLIP_RUN_ID = runId;

  const taskId = runtimeTaskId(context);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  else delete env.PAPERCLIP_TASK_ID;

  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  else delete env.PAPERCLIP_API_KEY;
}

function assertConversationRuntimeBindings(
  context: Record<string, unknown>,
  authToken: string | null | undefined,
): void {
  if (context.conversationMode !== true) return;
  if (!runtimeTaskId(context)) {
    throw new Error("Paperclip conversation is missing PAPERCLIP_TASK_ID context");
  }
  if (!authToken) {
    throw new Error("Paperclip conversation is missing its ephemeral PAPERCLIP_API_KEY");
  }
}

/**
 * Resolves the effective working directory (CWD) paths based on agent instructions, 
 * configuration fallbacks, and local strategy configurations.
 * 
 * @param config - The raw adapter configuration dictionary.
 * @param workspaceContext - Parsed workspace settings from Paperclip context.
 * @returns Resolves the target CWD and the effective workspace fallback CWD.
 */
async function resolveEffectiveCwd(
  config: Record<string, unknown>,
  workspaceContext: Record<string, unknown>
): Promise<{ cwd: string; effectiveWorkspaceCwd: string }> {
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  return { cwd, effectiveWorkspaceCwd };
}

/**
 * Builds the comprehensive environment variables mapping for process spawning, 
 * injecting Antigravity specific selectors and Paperclip framework environment bindings.
 * 
 * @param runId - The unique sequence run identifier.
 * @param agent - The executing Paperclip Agent structure.
 * @param config - The raw adapter configuration dictionary.
 * @param model - The resolved Antigravity model name.
 * @param authToken - Optional authentication bearer token.
 * @returns An environment mapping ready for process injection.
 */
function buildExecutionEnvironment(
  runId: string,
  agent: AdapterAgent,
  config: Record<string, unknown>,
  model: string,
  context: Record<string, unknown>,
  authToken: string | null | undefined
): { env: Record<string, string>; envConfig: Record<string, unknown> } {
  const envConfig = { ...parseObject(config.env) };
  delete envConfig.PAPERCLIP_API_KEY;
  delete envConfig.PAPERCLIP_WAKE_PAYLOAD_JSON;
  const env: Record<string, string> = {};

  if (model && model !== DEFAULT_ANTIGRAVITY_LOCAL_MODEL) {
    env.ANTIGRAVITY_MODEL = model;
  }

  applyTrustedPaperclipRuntimeEnv(env, runId, agent, context, authToken);

  return { env, envConfig };
}

/**
 * Compiles the prompt template into a fully hydrated prompt payload block.
 * 
 * @param promptTemplate - The prompt template containing wildcards.
 * @param agent - The executing Paperclip Agent structure.
 * @param runId - The unique run ID sequence.
 * @param context - The global Paperclip execution context.
 * @returns The fully rendered prompt payload.
 */
function compileAgentPrompt(
  promptTemplate: string,
  agent: AdapterAgent,
  runId: string,
  context: Record<string, unknown>,
  resumedSession: boolean,
): string {
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    agent,
    context,
  };

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const conversationPrompt =
    context.conversationMode === true &&
    promptTemplate !== DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      ? renderTemplate(DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE, templateData)
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession,
  });
  return joinPromptSections([renderedPrompt, conversationPrompt, wakePrompt]);
}

/**
 * Generates the clean CLI argument list for spawning the `agy` process.
 * Maps session IDs, prompts, and active workspaces to repeatable arguments.
 * 
 * @param prompt - The compiled orchestrator prompt payload.
 * @param resumeSessionId - Optional session ID to resume (resets turn contexts).
 * @param workspaces - Active Paperclip workspace mappings to register.
 * @param sandbox - Indicates whether OS and terminal sandboxing is enabled.
 * @param extraArgs - Structured list of user-defined CLI arguments to append.
 * @returns An array representing the formatted CLI arguments list.
 */
function compileAgyArguments(
  prompt: string,
  resumeSessionId: string | null,
  workspaces: unknown[],
  sandbox: boolean,
  extraArgs: string[]
): string[] {
  const args = ["--print", prompt, "--output-format", "stream-json"];
  if (resumeSessionId) {
    args.push("--conversation", resumeSessionId);
  }
  
  for (const ws of workspaces) {
    const wsObj = parseObject(ws);
    const wsCwd = asString(wsObj.cwd, "");
    if (wsCwd.length > 0) {
      args.push("--add-dir", wsCwd);
    }
  }

  args.push("--dangerously-skip-permissions");
  if (sandbox) {
    args.push("--sandbox");
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args;
}

/**
 * Core execution engine function for Google Antigravity local CLI integrations.
 * Decomposes process preparation, remote SSH workspace syncs, Paperclip bridge handshakes, 
 * and command invocation into a robust, strongly-typed pipeline.
 * 
 * @param ctx - The unified adapter execution context containing metadata, configurations, and logs handlers.
 * @returns A promise resolving to the final adapter execution output structure.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const configuredPromptTemplate = asString(config.promptTemplate, "").trim();
  const useConversationTemplate =
    context.conversationMode === true &&
    (!configuredPromptTemplate || configuredPromptTemplate === DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const promptTemplate = useConversationTemplate
    ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
    : configuredPromptTemplate || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

  assertConversationRuntimeBindings(context, authToken);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const { cwd, effectiveWorkspaceCwd } = await resolveEffectiveCwd(config, workspaceContext);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);

  const { env, envConfig } = buildExecutionEnvironment(runId, agent, config, model, context, authToken);

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource: asString(workspaceContext.source, ""),
    workspaceId: asString(workspaceContext.workspaceId, ""),
    workspaceRepoUrl: asString(workspaceContext.repoUrl, ""),
    workspaceRepoRef: asString(workspaceContext.repoRef, ""),
    workspaceHints: [],
    agentHome: asString(workspaceContext.agentHome, ""),
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Configuração do agente é aplicada durante o refresh. Reaplique por último
  // as vinculações emitidas pelo Paperclip para impedir sobrescrita ou spoofing.
  applyTrustedPaperclipRuntimeEnv(env, runId, agent, context, authToken);

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...sanitizeInheritedPaperclipEnv(process.env), ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);

  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });

  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let preparedExecutionTargetRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;

  if (executionTargetIsRemote) {
    try {
      await onLog("stdout", `[paperclip] Preparing remote execution target ${describeAdapterExecutionTarget(executionTarget)}...\n`);
      preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "antigravity",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: [],
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime!.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
    } catch (error) {
      await restoreRemoteWorkspace?.();
      throw error;
    }
  }

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir ?? null,
      adapterKey: "antigravity",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const prompt = compileAgentPrompt(promptTemplate, agent, runId, context, Boolean(sessionId));

  const runAttempt = async (resumeSessionId: string | null) => {
    const workspaces = Array.isArray(context.paperclipWorkspaces) ? context.paperclipWorkspaces : [];
    const args = compileAgyArguments(prompt, resumeSessionId, workspaces, sandbox, extraArgs);
    
    if (onMeta) {
      await onMeta({
        adapterType: "antigravity_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: ["Running Antigravity CLI in headless print mode"],
        commandArgs: args.map((val, idx) => (idx === 1 ? `<prompt ${prompt.length} chars>` : val)),
        env: loggedEnv,
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }

    return await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
  };

  try {
    const proc = await runAttempt(sessionId);
    
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: null,
        clearSession: false,
      };
    }

    const failed = (proc.exitCode ?? 0) !== 0;
    const rawStderr = proc.stderr.trim();
    const fallbackErrorMessage = firstNonEmptyLine(rawStderr) || `Antigravity exited with code ${proc.exitCode ?? -1}`;
    const parsed = parseAntigravityOutput(proc.stdout, proc.stderr);
    const effectiveErrorMessage = parsed.errorMessage ?? (failed ? fallbackErrorMessage : null);
    const effectiveSessionId = parsed.sessionId || sessionId;

    const resolvedSessionParams = effectiveSessionId
      ? {
          sessionId: effectiveSessionId,
          cwd: effectiveExecutionCwd,
          ...(asString(workspaceContext.workspaceId, "") ? { workspaceId: workspaceContext.workspaceId } : {}),
          ...(executionTargetIsRemote ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) } : {}),
        }
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: effectiveErrorMessage,
      errorCode: parsed.permissionDeniedFailure
        ? "antigravity_permission_denied"
        : null,
      usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      sessionId: effectiveSessionId || null,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: effectiveSessionId || null,
      provider: "google",
      biller: "google",
      model,
      billingType: "api",
      costUsd: null,
      resultJson: {
        result: parsed.response,
        session_id: parsed.sessionId,
        usage: parsed.usage ?? null,
        denied_action_count: parsed.deniedActionCount,
        denied_action_types: parsed.deniedActionTypes,
      },
      summary: effectiveErrorMessage ? "" : parsed.response,
      question: null,
      clearSession: false,
    };
  } finally {
    await Promise.all([
      paperclipBridge?.stop(),
      restoreRemoteWorkspace?.(),
    ]);
  }
}
