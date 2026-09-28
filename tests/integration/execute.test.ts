import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "@paperclipai/adapter-utils/server-utils";
import { createServerAdapter } from "../../src/index.js";
import { execute } from "../../src/server/execute.js";

const {
  runAdapterExecutionTargetProcess,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "Success",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/local/bin/agy"),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
    ensureAdapterExecutionTargetCommandResolvable,
    resolveAdapterExecutionTargetCommandForLogs,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(async () => undefined),
  };
});

/**
 * Integration test suite for the local Antigravity execution flow.
 * Mocks the system process spawn APIs to assert correct argument building, 
 * environment variables injection, and multi-workspace support.
 */
describe("antigravity local execution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Assures that a basic local run correctly resolves and spawns the `agy` process
   * with the expected prompt and unattended permission flags.
   */
  it("successfully invokes agy with local command and correct prompt", async () => {
    const result = await execute({
      runId: "run-local-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Success");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    const cliArgs = callArgs[3];
    expect(cliArgs).toContain("--print");
    expect(cliArgs).toContain("--output-format");
    expect(cliArgs).toContain("stream-json");
    expect(cliArgs).toContain("--dangerously-skip-permissions");
  });

  it("sinaliza falha estruturada quando o agy nega ação e não responde", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "command", command: "conteúdo sensível" }],
      }),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-denied-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "agy" },
      context: {
        paperclipWorkspace: { cwd: "/home/user/workspace", source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("antigravity_permission_denied");
    expect(result.errorMessage).toContain("ação(ões)");
    expect(result.errorMessage).not.toContain("conteúdo sensível");
    expect(result.summary).toBe("");
    expect(result.resultJson).toMatchObject({
      result: "",
      denied_action_count: 1,
      denied_action_types: ["command"],
    });
  });

  /**
   * Asserts that model selection is correctly bound to `env.ANTIGRAVITY_MODEL`
   * and that no invalid `--model` CLI parameters are appended.
   */
  it("configures model via env.ANTIGRAVITY_MODEL and does not pass --model CLI flag", async () => {
    await execute({
      runId: "run-local-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
        model: "claude-sonnet-4.6-thinking",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace",
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[], { env: Record<string, string> }];
    const cliArgs = callArgs[3];
    const options = callArgs[4];

    expect(cliArgs).not.toContain("--model");
    expect(options.env.ANTIGRAVITY_MODEL).toBe("claude-sonnet-4.6-thinking");
  });

  /**
   * Asserts that multiple active workspaces are mapped correctly using
   * repeatable `--add-dir` flags on the spawned command line.
   */
  it("appends multiple workspaces using repeatable --add-dir CLI flags", async () => {
    await execute({
      runId: "run-local-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Antigravity CEO",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "agy",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/home/user/workspace-1",
          source: "project_primary",
        },
        paperclipWorkspaces: [
          { cwd: "/home/user/workspace-1" },
          { cwd: "/home/user/workspace-2" },
        ],
      },
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [string, unknown, string, string[]];
    const cliArgs = callArgs[3];

    let addDirIndices: number[] = [];
    cliArgs.forEach((arg, idx) => {
      if (arg === "--add-dir") addDirIndices.push(idx);
    });

    expect(addDirIndices.length).toBe(2);
    expect(cliArgs[addDirIndices[0] + 1]).toBe("/home/user/workspace-1");
    expect(cliArgs[addDirIndices[1] + 1]).toBe("/home/user/workspace-2");
  });

  it("declara suporte à credencial JWT local emitida pelo Paperclip", () => {
    expect(createServerAdapter().supportsLocalAgentJwt).toBe(true);
  });

  it("injeta identidade confiável da execução sem permitir sobrescrita pela configuração", async () => {
    await execute({
      runId: "run-chat-1",
      agent: {
        id: "agent-trusted",
        companyId: "company-trusted",
        name: "Líder de Ambiente",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "agy",
        env: {
          PAPERCLIP_API_KEY: "chave-configurada-nao-confiavel",
          PAPERCLIP_RUN_ID: "run-forjado",
          PAPERCLIP_TASK_ID: "task-forjada",
          PAPERCLIP_AGENT_ID: "agent-forjado",
        },
      },
      context: {
        taskId: "chat-issue-1",
        paperclipWorkspace: { cwd: "/home/user/workspace", source: "agent_home" },
      },
      authToken: "jwt-efemero-oficial",
      onLog: async () => {},
    });

    const callArgs = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(callArgs[4].env).toMatchObject({
      PAPERCLIP_API_KEY: "jwt-efemero-oficial",
      PAPERCLIP_RUN_ID: "run-chat-1",
      PAPERCLIP_TASK_ID: "chat-issue-1",
      PAPERCLIP_AGENT_ID: "agent-trusted",
      PAPERCLIP_COMPANY_ID: "company-trusted",
    });
  });

  it("usa contrato de conversa e inclui a mensagem recebida no wake payload", async () => {
    const onMeta = vi.fn(async () => {});
    await execute({
      runId: "run-chat-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Líder de Ambiente",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "agy",
        // O formulário do Paperclip pode persistir o default antigo explicitamente.
        promptTemplate: DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
      },
      context: {
        conversationMode: true,
        issueId: "chat-issue-2",
        paperclipWorkspace: { cwd: "/home/user/workspace", source: "agent_home" },
        paperclipWake: {
          reason: "comment_added",
          issue: { id: "chat-issue-2", identifier: "ENG-44", title: "Chat", status: "in_progress" },
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          comments: [{ id: "comment-1", body: "INICIAR_PLANEJAMENTO_ASSISTIDO_V1", authorType: "user" }],
          fallbackFetchNeeded: false,
        },
      },
      authToken: "jwt-oficial",
      onLog: async () => {},
      onMeta,
    });

    const prompt = onMeta.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("Continue the Paperclip conversation");
    expect(prompt).toContain("INICIAR_PLANEJAMENTO_ASSISTIDO_V1");
    expect(prompt).toContain("Never discover Paperclip endpoints by reading its source code");
    expect(prompt).not.toContain("Start actionable work in this heartbeat; do not stop at a plan");
  });

  it("preserva prompt personalizado sem remover o contrato seguro de conversa", async () => {
    const onMeta = vi.fn(async () => {});
    await execute({
      runId: "run-chat-custom",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Líder",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "agy", promptTemplate: "INSTRUÇÃO PERSONALIZADA {{agent.id}}" },
      context: {
        conversationMode: true,
        taskId: "chat-custom",
        paperclipWorkspace: { cwd: "/home/user/workspace", source: "agent_home" },
      },
      authToken: "jwt-oficial",
      onLog: async () => {},
      onMeta,
    });

    const prompt = onMeta.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("INSTRUÇÃO PERSONALIZADA agent-1");
    expect(prompt).toContain("Never discover Paperclip endpoints by reading its source code");
  });

  it.each([
    {
      label: "credencial efêmera",
      context: { conversationMode: true, taskId: "chat-1" },
      authToken: undefined,
      expected: "PAPERCLIP_API_KEY",
    },
    {
      label: "ID da conversa",
      context: { conversationMode: true },
      authToken: "jwt-oficial",
      expected: "PAPERCLIP_TASK_ID",
    },
  ])("falha rapidamente quando falta $label", async ({ context, authToken, expected }) => {
    await expect(execute({
      runId: "run-chat-invalido",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Líder",
        adapterType: "antigravity_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "agy" },
      context,
      authToken,
      onLog: async () => {},
    })).rejects.toThrow(expected);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
