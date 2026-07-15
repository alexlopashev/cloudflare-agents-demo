import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InvestigationAgentState,
  PlatformEnvironment,
  RegressionSurgeonAgent,
} from "../../workers/platform/src/index";
import { createTelemetryStore } from "../../workers/platform/src/telemetry/store";
import { openAgentChatProtocol } from "../support/agent-chat-protocol";

declare global {
  namespace Cloudflare {
    interface Env extends PlatformEnvironment {}
  }
}

async function seedRegressionEvidence() {
  const store = createTelemetryStore(env.TELEMETRY_DB);
  for (const [releaseId, gitSha, deployedAtMs, durationMs] of [
    ["baseline-concurrent", "cf25e5253b106b1e7514340abe94bd42fd748725", 1_700_000_000_000, 130],
    ["regression-sequential", "d591869a8ef995f1835ef80152f4de085b10255b", 1_700_086_400_000, 381],
  ] as const) {
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      const traceId = `${releaseId}-trace-${sequence}`;
      const interactionId = `${releaseId}-interaction-${sequence}`;
      const startedAtMs = deployedAtMs + sequence * 1_000;
      const serviceDuration = releaseId === "regression-sequential" ? 127 : 125;
      await store.recordTrace({
        release: { releaseId, gitSha, deployedAtMs },
        trace: {
          traceId,
          interactionId,
          releaseId,
          startedAtMs,
          durationMs,
          outcome: "success",
        },
        spans: [
          {
            traceId,
            spanId: "request",
            parentSpanId: null,
            serviceId: "platform",
            startedAtMs,
            durationMs,
            status: "success",
          },
          ...["api", "jobs", "storage"].map((serviceId, index) => ({
            traceId,
            spanId: `service-${serviceId}`,
            parentSpanId: "request",
            serviceId,
            startedAtMs:
              startedAtMs + (releaseId === "regression-sequential" ? serviceDuration * index : 0),
            durationMs: serviceDuration,
            status: "success" as const,
          })),
        ],
      });
      await store.recordUxEvent({
        interactionId,
        traceId,
        releaseId,
        metricName: "service_grid_ready_ms",
        durationMs,
        outcome: "success",
        recordedAtMs: startedAtMs + durationMs,
      });
    }
  }
}

describe("RegressionSurgeonAgent investigation policy", () => {
  beforeEach(async () => {
    await env.TELEMETRY_DB.exec(
      `PRAGMA foreign_keys = OFF;
       DROP TABLE IF EXISTS ux_events; DROP TABLE IF EXISTS spans; DROP TABLE IF EXISTS traces; DROP TABLE IF EXISTS releases;
       PRAGMA foreign_keys = ON;
       CREATE TABLE releases (release_id TEXT PRIMARY KEY, git_sha TEXT NOT NULL, deployed_at_ms INTEGER NOT NULL);
       CREATE TABLE traces (trace_id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, release_id TEXT NOT NULL, started_at_ms INTEGER NOT NULL, duration_ms REAL NOT NULL, outcome TEXT NOT NULL, FOREIGN KEY (release_id) REFERENCES releases(release_id));
       CREATE TABLE spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, service_id TEXT NOT NULL, started_at_ms INTEGER NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, PRIMARY KEY (trace_id, span_id), FOREIGN KEY (trace_id) REFERENCES traces(trace_id));
       CREATE TABLE ux_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL, trace_id TEXT NOT NULL, release_id TEXT NOT NULL, metric_name TEXT NOT NULL, duration_ms REAL NOT NULL, outcome TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL, UNIQUE (interaction_id, metric_name), FOREIGN KEY (trace_id) REFERENCES traces(trace_id), FOREIGN KEY (release_id) REFERENCES releases(release_id));`.replace(
        /\s+/g,
        " ",
      ),
    );
  });

  it("offers only evidence tools with an evidence-first prompt and hard step limit", async () => {
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("investigation-policy");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const policy = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        actionApproval: unknown;
        actions: string[];
        activeTools: unknown;
        maxRetries: unknown;
        maxSteps: number;
        prompt: string;
        tools: string[];
        workspaceBash: unknown;
      }
    >(stub, async (instance) => {
      await instance.onStart();
      const turn = await instance.beforeTurn({} as never);
      const actions = await instance.getActions();
      return {
        actionApproval: actions.create_draft_pr?.config.approval,
        actions: Object.keys(actions),
        activeTools: turn?.activeTools,
        maxRetries: turn?.maxRetries,
        maxSteps: instance.maxSteps,
        prompt: instance.getSystemPrompt(),
        tools: Object.keys(instance.getTools()),
        workspaceBash: instance.workspaceBash,
      };
    });

    expect(policy).toEqual({
      actionApproval: true,
      actions: ["create_draft_pr"],
      activeTools: [
        "compare_releases",
        "find_slow_traces",
        "inspect_trace",
        "inspect_release",
        "read_repo_files",
      ],
      maxRetries: 1,
      maxSteps: 16,
      prompt: expect.stringMatching(/evidence[\s\S]+inference[\s\S]+confidence[\s\S]+unknowns/i),
      tools: [
        "compare_releases",
        "find_slow_traces",
        "inspect_trace",
        "inspect_release",
        "read_repo_files",
      ],
      workspaceBash: false,
    });
    expect(policy.prompt).toMatch(/do not repeat a successful tool operation/i);
    expect(policy.prompt).toMatch(
      /before[^.]+final[^.]+must[^.]+compare releases[^.]+find slow\s+traces[^.]+inspect one representative trace[^.]+inspect the degraded release[^.]+read the relevant\s+allowlisted source/is,
    );
    expect(policy.prompt).not.toMatch(
      /Never claim\s+that a write, deployment, rollback, or pull-request creation occurred\./,
    );
  });

  it("bounds a gateway budget 429 without changing persisted evidence or enabling remediation", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("gateway-budget-exhausted");
    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      { error: string; stateAfter: InvestigationAgentState; stateBefore: InvestigationAgentState }
    >(stub, async (instance) => {
      const stateBefore = instance.startConfiguredInvestigation();
      const providerFailure = () =>
        new APICallError({
          message: "private provider message",
          url: "https://private.example/provider",
          requestBodyValues: { secret: "must-not-leak" },
          statusCode: 429,
          responseBody: "daily spend limit exceeded with private identifiers",
        });
      const bounded = instance.onChatError(
        new RetryError({
          message: "two private provider attempts failed",
          reason: "maxRetriesExceeded",
          errors: [providerFailure(), providerFailure()],
        }),
      );
      return {
        error: bounded instanceof Error ? bounded.message : String(bounded),
        stateAfter: instance.state,
        stateBefore,
      };
    });

    expect(result.error).toMatch(/model.*temporarily unavailable/i);
    expect(result.error).toMatch(/UTC/i);
    expect(result.error).not.toMatch(/private|secret|provider\.example/i);
    expect(result.stateAfter).toEqual(result.stateBefore);
    expect(result.stateAfter).not.toHaveProperty("preparedRemediation");
  });

  it("rejects an exhausted paid turn before starting investigation state or a continuation", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("public-turn-limit");
    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      { calls: number; error: string; state: InvestigationAgentState }
    >(stub, async (instance) => {
      const instanceEnvironment = Reflect.get(instance, "env") as PlatformEnvironment;
      const limit = vi.fn(async () => ({ success: false }));
      const originalMode = instanceEnvironment.MODEL_MODE;
      const originalGateway = instanceEnvironment.AI_GATEWAY_ID;
      const originalUsageMode = instanceEnvironment.PUBLIC_USAGE_MODE;
      const originalLimiter = instanceEnvironment.PUBLIC_AI_TURN_LIMITER;
      let error = "";
      try {
        instanceEnvironment.MODEL_MODE = "workers-ai";
        instanceEnvironment.AI_GATEWAY_ID = "regression-surgeon";
        instanceEnvironment.PUBLIC_USAGE_MODE = "rate-limited";
        instanceEnvironment.PUBLIC_AI_TURN_LIMITER = { limit } as RateLimit;
        await instance.beforeTurn({
          continuation: false,
          messages: [{ role: "user", content: "Investigate the latency regression." }],
        } as never);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        instanceEnvironment.MODEL_MODE = originalMode;
        instanceEnvironment.PUBLIC_USAGE_MODE = originalUsageMode;
        if (originalGateway === undefined) delete instanceEnvironment.AI_GATEWAY_ID;
        else instanceEnvironment.AI_GATEWAY_ID = originalGateway;
        if (originalLimiter === undefined) delete instanceEnvironment.PUBLIC_AI_TURN_LIMITER;
        else instanceEnvironment.PUBLIC_AI_TURN_LIMITER = originalLimiter;
      }
      await instance.beforeTurn({ continuation: true, messages: [] } as never);
      return { calls: limit.mock.calls.length, error, state: instance.state };
    });

    expect(result).toEqual({
      calls: 1,
      error: expect.stringMatching(/public investigator limit reached.*60 seconds/i),
      state: { status: "idle" },
    });
  });

  it("makes every evidence operation explicit in the programmatic investigation request", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName(
      "programmatic-investigation-contract",
    ) as unknown as DurableObjectStub<RegressionSurgeonAgent>;

    const input = await runInDurableObject<RegressionSurgeonAgent, string | undefined>(
      stub,
      async (instance) => {
        const runTurn = vi.spyOn(instance, "runTurn").mockResolvedValue(undefined as never);
        await instance.runLocalInvestigation();
        const capturedInput = runTurn.mock.calls[0]?.[0].input;
        if (typeof capturedInput !== "string") {
          throw new Error("Programmatic investigation input was not a string.");
        }
        return capturedInput;
      },
    );

    expect(input).toMatch(/compare releases/i);
    expect(input).toMatch(/find slow traces/i);
    expect(input).toMatch(/inspect one representative trace/i);
    expect(input).toMatch(/inspect the degraded release/i);
    expect(input).toMatch(/read the relevant allowlisted source/i);
    expect(input).toMatch(/before (?:the )?final report/i);
  });

  it("removes evidence tools from the final report step after the receipt completes", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("complete-receipt-final-report");
    const finalPolicy = await runInDurableObject<
      RegressionSurgeonAgent,
      Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>
    >(stub, async (instance) => {
      const beforeStep = vi.spyOn(instance, "beforeStep");
      await instance.runLocalInvestigation();
      const policies = await Promise.all(beforeStep.mock.results.map((result) => result.value));
      return policies.at(-1);
    });

    expect(finalPolicy).toMatchObject({ activeTools: [] });
    expect(finalPolicy?.system).toMatch(/final report/i);
  });

  it("forces the next missing evidence capability before Project Think can finalize", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("evidence-step-policy");
    const policy = await runInDurableObject<
      RegressionSurgeonAgent,
      Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>
    >(stub, async (instance) => {
      instance.startConfiguredInvestigation();
      return instance.beforeStep({
        messages: [],
        stepNumber: 4,
        steps: [
          {
            toolResults: [
              {
                toolCallId: "compare-call",
                toolName: "compare_releases",
                input: {
                  baselineReleaseId: "baseline-concurrent",
                  candidateReleaseId: "regression-sequential",
                  windowMs: 60_000,
                },
                output: {
                  status: "ready",
                  windowMs: 30 * 24 * 60 * 60 * 1_000,
                  baseline: { count: 20, p50Ms: 130, p75Ms: 130, p95Ms: 130, errorRate: 0 },
                  candidate: { count: 20, p50Ms: 380, p75Ms: 380, p95Ms: 380, errorRate: 0 },
                  delta: { p75Ms: 250 },
                },
              },
            ],
          },
          {
            toolResults: [
              {
                toolCallId: "slow-call",
                toolName: "find_slow_traces",
                input: {
                  releaseId: "regression-sequential",
                  sinceMs: 1_700_086_400_000,
                  untilMs: 1_700_086_460_000,
                  limit: 5,
                },
                output: [
                  {
                    traceId: "trace-36",
                    interactionId: "interaction-36",
                    releaseId: "regression-sequential",
                    startedAtMs: 1_700_086_436_000,
                    durationMs: 380,
                    outcome: "success",
                  },
                ],
              },
            ],
          },
          {
            toolResults: [
              {
                toolCallId: "trace-call",
                toolName: "inspect_trace",
                input: { traceId: "trace-36" },
                output: {
                  trace: {
                    traceId: "trace-36",
                    interactionId: "interaction-36",
                    releaseId: "regression-sequential",
                    startedAtMs: 1_700_086_436_000,
                    durationMs: 380,
                    outcome: "success",
                  },
                  criticalPath: { diagnostics: [], spanIds: ["request"], wallTimeMs: 380 },
                  tree: [{ span: { spanId: "request" } }],
                },
              },
            ],
          },
          {
            toolResults: [
              {
                toolCallId: "release-call",
                toolName: "inspect_release",
                input: { versionId: "regression-sequential" },
                output: {
                  release: {
                    versionId: "regression-sequential",
                    commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
                  },
                  commit: {
                    sha: "d591869a8ef995f1835ef80152f4de085b10255b",
                    changes: [{ path: "workers/platform/src/api/health.ts" }],
                  },
                  pullRequest: { status: "found", number: 19 },
                },
              },
            ],
          },
        ],
      } as never);
    });

    expect(policy).toMatchObject({
      activeTools: ["read_repo_files"],
      toolChoice: { type: "tool", toolName: "read_repo_files" },
    });
    expect(policy?.system).toMatch(/complete the missing evidence operation/i);
  });

  it("hands the current-step receipt selector to the immediately following trace tool", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("current-step-trace-selector");
    const result = await runInDurableObject<RegressionSurgeonAgent, unknown>(
      stub,
      async (instance) => {
        instance.startConfiguredInvestigation();
        await instance.beforeStep({
          messages: [],
          stepNumber: 2,
          steps: [
            {
              toolResults: [
                {
                  toolCallId: "compare-current-step",
                  toolName: "compare_releases",
                  input: {},
                  output: {
                    status: "ready",
                    windowMs: 30 * 24 * 60 * 60 * 1_000,
                    baseline: { count: 20, p50Ms: 130, p75Ms: 130, p95Ms: 130, errorRate: 0 },
                    candidate: { count: 20, p50Ms: 381, p75Ms: 381, p95Ms: 381, errorRate: 0 },
                    delta: { p75Ms: 251 },
                  },
                },
              ],
            },
            {
              toolResults: [
                {
                  toolCallId: "slow-current-step",
                  toolName: "find_slow_traces",
                  input: {},
                  output: [
                    {
                      traceId: "regression-sequential-trace-20",
                      interactionId: "regression-sequential-interaction-20",
                      releaseId: "regression-sequential",
                      startedAtMs: 1_700_086_420_000,
                      durationMs: 381,
                      outcome: "success",
                    },
                  ],
                },
              ],
            },
          ],
        } as never);
        const tool = instance.getTools().inspect_trace as {
          execute?: (input: unknown, options: unknown) => Promise<unknown>;
        };
        if (tool.execute === undefined) throw new Error("Trace tool was not executable.");
        return tool.execute({}, {});
      },
    );

    expect(result).toMatchObject({
      trace: { traceId: "regression-sequential-trace-20", releaseId: "regression-sequential" },
    });
  });

  it("orders overlapping persisted and current-step evidence by the configured phase chain", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("overlapping-step-evidence");
    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        policy: Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>;
        receipt: InvestigationAgentState;
      }
    >(stub, async (instance) => {
      instance.startConfiguredInvestigation();
      await instance.beforeStep({
        messages: [],
        stepNumber: 2,
        steps: [
          {
            toolResults: [
              {
                toolCallId: "compare-before-overlap",
                toolName: "compare_releases",
                input: {},
                output: {
                  status: "ready",
                  windowMs: 30 * 24 * 60 * 60 * 1_000,
                  baseline: { count: 20, p50Ms: 130, p75Ms: 130, p95Ms: 130, errorRate: 0 },
                  candidate: { count: 20, p50Ms: 381, p75Ms: 381, p95Ms: 381, errorRate: 0 },
                  delta: { p75Ms: 251 },
                },
              },
            ],
          },
          {
            toolResults: [
              {
                toolCallId: "slow-before-overlap",
                toolName: "find_slow_traces",
                input: {},
                output: [
                  {
                    traceId: "regression-sequential-trace-20",
                    interactionId: "regression-sequential-interaction-20",
                    releaseId: "regression-sequential",
                    startedAtMs: 1_700_086_420_000,
                    durationMs: 381,
                    outcome: "success",
                  },
                ],
              },
            ],
          },
        ],
      } as never);

      const releaseResult = {
        release: {
          versionId: "regression-sequential",
          commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
        },
        commit: {
          sha: "d591869a8ef995f1835ef80152f4de085b10255b",
          changes: [{ path: "workers/platform/src/api/health.ts" }],
        },
        pullRequest: { status: "found", number: 19 },
      };
      const policy = await instance.beforeStep({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Investigate the latency regression" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "release-persisted-first",
                toolName: "inspect_release",
                input: {},
              },
              {
                type: "tool-result",
                toolCallId: "release-persisted-first",
                toolName: "inspect_release",
                output: releaseResult,
              },
            ],
          },
        ],
        stepNumber: 3,
        steps: [
          {
            toolResults: [
              {
                toolCallId: "trace-current-step-earlier",
                toolName: "inspect_trace",
                input: {},
                output: {
                  trace: {
                    traceId: "regression-sequential-trace-20",
                    interactionId: "regression-sequential-interaction-20",
                    releaseId: "regression-sequential",
                    startedAtMs: 1_700_086_420_000,
                    durationMs: 381,
                    outcome: "success",
                  },
                  criticalPath: {
                    diagnostics: [],
                    spanIds: ["request"],
                    wallTimeMs: 381,
                  },
                  tree: [{ span: { spanId: "request" } }],
                },
              },
            ],
          },
        ],
      } as never);
      return { policy, receipt: instance.state };
    });

    expect(result.policy).toMatchObject({
      activeTools: ["read_repo_files"],
      toolChoice: { type: "tool", toolName: "read_repo_files" },
    });
    expect(result.receipt.status).toBe("investigating");
    if (result.receipt.status !== "investigating") throw new Error("Investigation state was lost.");
    expect(result.receipt.receipt.phases[2]?.status).toBe("complete");
    expect(result.receipt.receipt.phases[3]).toMatchObject({
      status: "complete",
      attempts: [expect.objectContaining({ reason: "validated" })],
    });
  });

  it("removes evidence tools after the current phase exhausts its one retry", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("evidence-retry-exhaustion");
    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        policy: Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>;
        receipt: InvestigationAgentState;
      }
    >(stub, async (instance) => {
      instance.startConfiguredInvestigation();
      const policy = await instance.beforeStep({
        messages: [],
        stepNumber: 2,
        steps: ["first-failure", "retry-failure"].map((toolCallId) => ({
          toolResults: [
            {
              toolCallId,
              toolName: "compare_releases",
              input: {},
              output: { status: "error", code: "unavailable" },
            },
          ],
        })),
      } as never);
      return { policy, receipt: instance.state };
    });

    expect(result.policy).toMatchObject({ activeTools: [] });
    expect(result.policy).not.toHaveProperty("toolChoice");
    expect(result.policy?.system).toMatch(/bounded retry is exhausted/i);
    expect(result.receipt.status).toBe("investigating");
    if (result.receipt.status !== "investigating") throw new Error("Investigation state was lost.");
    expect(result.receipt.receipt.phases[0]).toEqual({
      toolName: "compare_releases",
      status: "error",
      attempts: [
        expect.objectContaining({ toolCallId: "first-failure" }),
        expect.objectContaining({ toolCallId: "retry-failure" }),
      ],
    });
    expect(result.receipt).not.toHaveProperty("preparedRemediation");
  });

  it("starts the evidence chain for an investigation request but not ordinary chat", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("evidence-step-intent");
    const policies = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        chat: Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>;
        investigation: Awaited<ReturnType<RegressionSurgeonAgent["beforeStep"]>>;
      }
    >(stub, async (instance) => ({
      chat: await instance.beforeStep({
        messages: [{ role: "user", content: [{ type: "text", text: "Thanks" }] }],
        stepNumber: 0,
        steps: [],
      } as never),
      investigation: await instance.beforeStep({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Investigate the latency regression" }],
          },
        ],
        stepNumber: 0,
        steps: [],
      } as never),
    }));

    expect(policies.chat).toBeUndefined();
    expect(policies.investigation).toMatchObject({
      activeTools: ["compare_releases"],
      toolChoice: { type: "tool", toolName: "compare_releases" },
    });
  });

  it("exposes the deterministic investigation through its local RPC boundary", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("local-rpc-boundary") as unknown as {
      runLocalInvestigation(): Promise<{
        preparedRemediation: {
          diff: {
            additions: number;
            currentContent: string;
            deletions: number;
            path: string;
            replacementContent: string;
          };
          fingerprint: string;
          writeEnabled: boolean;
        };
        report: string;
        receipt: { investigationId: string; phases: { status: string }[] };
        toolTypes: string[];
      }>;
    };

    const result = await stub.runLocalInvestigation();

    expect(result.toolTypes).toEqual([
      "tool-compare_releases",
      "tool-find_slow_traces",
      "tool-inspect_trace",
      "tool-inspect_release",
      "tool-read_repo_files",
    ]);
    expect(result.receipt.phases.every((phase) => phase.status === "complete")).toBe(true);
    expect(result.preparedRemediation).toMatchObject({
      diff: {
        additions: expect.any(Number),
        currentContent: expect.stringMatching(/loadingMode === "sequential"/),
        deletions: expect.any(Number),
        path: "workers/platform/src/api/health.ts",
        replacementContent: expect.stringMatching(/maximumConcurrentChecks = 2/),
      },
      fingerprint: expect.stringMatching(/^proposal-v1-[0-9a-f]{16}$/),
      writeEnabled: false,
    });
    expect(result.report).toMatch(/Evidence[\s\S]+Inference[\s\S]+Confidence[\s\S]+Unknowns/i);
    expect(result.report).toContain(result.receipt.investigationId);
  });

  it("keeps deployment smoke remediation preview-only when production writes are enabled", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName(
      "write-enabled-smoke-preview",
    ) as unknown as {
      runLocalInvestigation(): Promise<unknown>;
      runLocalRemediationPreview(): Promise<unknown>;
    };
    await stub.runLocalInvestigation();

    const result = await runInDurableObject<RegressionSurgeonAgent, unknown>(
      stub as unknown as DurableObjectStub<RegressionSurgeonAgent>,
      async (instance) => {
        const instanceEnvironment = Reflect.get(instance, "env") as PlatformEnvironment;
        const originalMode = instanceEnvironment.MODEL_MODE;
        const originalToken = instanceEnvironment.GITHUB_TOKEN;
        const originalWriteEnabled = instanceEnvironment.GITHUB_WRITE_ENABLED;
        try {
          instanceEnvironment.MODEL_MODE = "workers-ai";
          instanceEnvironment.GITHUB_TOKEN = "scoped-token";
          instanceEnvironment.GITHUB_WRITE_ENABLED = "true";
          return await instance.runLocalRemediationPreview();
        } finally {
          instanceEnvironment.MODEL_MODE = originalMode;
          if (originalToken === undefined) delete instanceEnvironment.GITHUB_TOKEN;
          else instanceEnvironment.GITHUB_TOKEN = originalToken;
          instanceEnvironment.GITHUB_WRITE_ENABLED = originalWriteEnabled;
        }
      },
    );

    expect(result).toMatchObject({ status: "preview", writesPerformed: false });
  });

  it("runs and persists a real multi-step evidence investigation without duplicated effects", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const baselineSha = "cf25e5253b106b1e7514340abe94bd42fd748725";
    const regressionSha = "d591869a8ef995f1835ef80152f4de085b10255b";
    for (const [releaseId, gitSha, deployedAtMs, durationMs] of [
      ["baseline-concurrent", baselineSha, 1_700_000_000_000, 130],
      ["regression-sequential", regressionSha, 1_700_086_400_000, 381],
    ] as const) {
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        const traceId = `${releaseId}-trace-${sequence}`;
        const interactionId = `${releaseId}-interaction-${sequence}`;
        const startedAtMs = deployedAtMs + sequence * 1_000;
        await store.recordTrace({
          release: { releaseId, gitSha, deployedAtMs },
          trace: {
            traceId,
            interactionId,
            releaseId,
            startedAtMs,
            durationMs,
            outcome: "success",
          },
          spans: [
            {
              traceId,
              spanId: "request",
              parentSpanId: null,
              serviceId: "platform",
              startedAtMs,
              durationMs,
              status: "success",
            },
            {
              traceId,
              spanId: "service-api",
              parentSpanId: "request",
              serviceId: "api",
              startedAtMs,
              durationMs: releaseId === "regression-sequential" ? 127 : 125,
              status: "success",
            },
            {
              traceId,
              spanId: "service-jobs",
              parentSpanId: "request",
              serviceId: "jobs",
              startedAtMs: startedAtMs + (releaseId === "regression-sequential" ? 127 : 0),
              durationMs: 127,
              status: "success",
            },
            {
              traceId,
              spanId: "service-storage",
              parentSpanId: "request",
              serviceId: "storage",
              startedAtMs: startedAtMs + (releaseId === "regression-sequential" ? 254 : 0),
              durationMs: 127,
              status: "success",
            },
          ],
        });
        await store.recordUxEvent({
          interactionId,
          traceId,
          releaseId,
          metricName: "service_grid_ready_ms",
          durationMs,
          outcome: "success",
          recordedAtMs: startedAtMs + durationMs,
        });
      }
    }

    const id = env.REGRESSION_SURGEON_AGENT.idFromName("multi-step-investigation");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);
    const beforeEviction = await runInDurableObject<
      RegressionSurgeonAgent,
      { messages: unknown[]; toolTypes: string[] }
    >(stub, async (instance) => {
      await instance.onStart();
      await instance.runTurn({ input: "Investigate the measured latency regression." });
      const messages = await instance.getMessages();
      const toolTypes = messages.flatMap((message) =>
        message.parts.map((part) => part.type).filter((type) => type.startsWith("tool-")),
      );
      return { messages, toolTypes };
    });

    expect(beforeEviction.toolTypes).toEqual([
      "tool-compare_releases",
      "tool-find_slow_traces",
      "tool-inspect_trace",
      "tool-inspect_release",
      "tool-read_repo_files",
    ]);
    expect(JSON.stringify(beforeEviction.messages)).toMatch(
      /Evidence[\s\S]+regression-sequential-trace-[12][\s\S]+d591869[\s\S]+PR #19/,
    );

    await evictDurableObject(stub);
    const afterEviction = await runInDurableObject<RegressionSurgeonAgent, unknown[]>(
      stub,
      async (instance) => {
        await instance.onStart();
        return instance.getMessages();
      },
    );
    expect(afterEviction).toEqual(beforeEviction.messages);
  });

  it("stops a deterministic runaway model path at sixteen tool steps", async () => {
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("runaway-step-limit");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const toolTypes = await runInDurableObject<RegressionSurgeonAgent, string[]>(
      stub,
      async (instance) => {
        await instance.onStart();
        await instance.runTurn({ input: "Exercise the runaway tool loop fixture." });
        const messages = await instance.getMessages();
        return messages.flatMap((message) =>
          message.parts.map((part) => part.type).filter((type) => type.startsWith("tool-")),
        );
      },
    );

    expect(toolTypes).toHaveLength(16);
    expect(new Set(toolTypes)).toEqual(new Set(["tool-compare_releases"]));
  });

  it("parks the guarded remediation action until explicit human approval", async () => {
    await seedRegressionEvidence();
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("approval-gated-remediation");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const pending = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        actionInputKeys: string[];
        approvalId: string | undefined;
        proposalFingerprint: string | undefined;
        output: unknown;
        state: string | undefined;
      }
    >(stub, async (instance) => {
      await instance.onStart();
      await instance.runTurn({ input: "Investigate the measured latency regression." });
      await instance.runTurn({ input: "Prepare the guarded remediation preview." });
      const messages = await instance.getMessages();
      const part = messages
        .flatMap((message) => message.parts)
        .find((candidate) => candidate.type === "tool-create_draft_pr");
      if (part === undefined || !("state" in part)) {
        return {
          actionInputKeys: [],
          approvalId: undefined,
          proposalFingerprint: undefined,
          output: undefined,
          state: undefined,
        };
      }
      const approval = "approval" in part ? part.approval : undefined;
      const input = "input" in part && typeof part.input === "object" ? part.input : undefined;
      return {
        actionInputKeys: input !== undefined && input !== null ? Object.keys(input).sort() : [],
        approvalId:
          approval !== undefined && typeof approval === "object" && approval !== null
            ? Reflect.get(approval, "id")
            : undefined,
        proposalFingerprint:
          "input" in part && typeof part.input === "object" && part.input !== null
            ? Reflect.get(part.input, "proposalFingerprint")
            : undefined,
        output: "output" in part ? part.output : undefined,
        state: typeof part.state === "string" ? part.state : undefined,
      };
    });

    expect(pending).toEqual({
      actionInputKeys: ["proposalFingerprint"],
      approvalId: expect.any(String),
      proposalFingerprint: expect.stringMatching(/^proposal-v1-[0-9a-f]{16}$/),
      output: undefined,
      state: "approval-requested",
    });
  });

  it("reaches evidence-gated remediation approval from the configured reviewer action", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("configured-reviewer-remediation");

    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        actionFingerprint: string | undefined;
        actionState: string | undefined;
        phaseStatuses: string[];
        preparedFingerprint: string | undefined;
        preparedTraceId: string | undefined;
        toolTypes: string[];
      }
    >(stub, async (instance) => {
      await instance.onStart();
      await instance.runTurn({
        input:
          "Investigate the seeded latency regression and prepare the guarded remediation preview.",
      });
      const messages = await instance.getMessages();
      const parts = messages.flatMap((message) => message.parts);
      const action = parts.find((part) => part.type === "tool-create_draft_pr");
      const actionInput =
        action !== undefined && "input" in action && typeof action.input === "object"
          ? action.input
          : undefined;
      const prepared =
        instance.state.status === "investigating" ? instance.state.preparedRemediation : undefined;
      return {
        actionFingerprint:
          actionInput !== undefined && actionInput !== null
            ? Reflect.get(actionInput, "proposalFingerprint")
            : undefined,
        actionState:
          action !== undefined && "state" in action && typeof action.state === "string"
            ? action.state
            : undefined,
        phaseStatuses:
          instance.state.status === "investigating"
            ? instance.state.receipt.phases.map((phase) => phase.status)
            : [],
        preparedFingerprint: prepared?.fingerprint,
        preparedTraceId: prepared?.proposal.incident.traceId,
        toolTypes: parts.map((part) => part.type).filter((type) => type.startsWith("tool-")),
      };
    });

    expect(result.phaseStatuses).toEqual(Array.from({ length: 5 }, () => "complete"));
    expect(result.toolTypes).toEqual([
      "tool-compare_releases",
      "tool-find_slow_traces",
      "tool-inspect_trace",
      "tool-inspect_release",
      "tool-read_repo_files",
      "tool-create_draft_pr",
    ]);
    expect(result.actionState).toBe("approval-requested");
    expect(result.actionFingerprint).toBe(result.preparedFingerprint);
    expect(result.preparedTraceId).toMatch(/^regression-sequential-trace-/);
  });

  it("preserves the complete receipt when browser approval resubmits the existing transcript", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("browser-approval-transcript");

    const result = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        afterFingerprint: string | undefined;
        afterInvestigationId: string | undefined;
        actionStatus: string;
        beforeFingerprint: string;
        beforeInvestigationId: string;
      }
    >(stub, async (instance) => {
      await instance.onStart();
      await instance.runTurn({
        input:
          "Investigate the seeded latency regression and prepare the guarded remediation preview.",
      });
      if (
        instance.state.status !== "investigating" ||
        instance.state.preparedRemediation === undefined
      ) {
        throw new Error("Expected a receipt-prepared remediation.");
      }
      const beforeInvestigationId = instance.state.investigationId;
      const beforeFingerprint = instance.state.preparedRemediation.fingerprint;

      await instance.beforeTurn({
        continuation: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Investigate the seeded latency regression and prepare the guarded remediation preview.",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: "create_draft_pr",
                toolCallId: "draft-1",
                input: { proposalFingerprint: beforeFingerprint },
              },
            ],
          },
        ],
      } as never);

      const action = instance.getActions().create_draft_pr;
      if (action === undefined) throw new Error("Expected the receipt-gated action.");
      const actionResult = await action.config.execute(
        { proposalFingerprint: beforeFingerprint },
        {} as never,
      );

      return {
        afterFingerprint:
          instance.state.status === "investigating"
            ? instance.state.preparedRemediation?.fingerprint
            : undefined,
        afterInvestigationId:
          instance.state.status === "investigating" ? instance.state.investigationId : undefined,
        actionStatus:
          typeof actionResult === "object" && actionResult !== null
            ? String(Reflect.get(actionResult, "status"))
            : "invalid",
        beforeFingerprint,
        beforeInvestigationId,
      };
    });

    expect(result.afterInvestigationId).toBe(result.beforeInvestigationId);
    expect(result.afterFingerprint).toBe(result.beforeFingerprint);
    expect(result.actionStatus).toBe("preview");
  });

  it("replays reconnect and deduplicates an approval resend", async () => {
    await seedRegressionEvidence();
    Reflect.set(env, "CF_VERSION_METADATA", {
      id: "worker-test-version",
      timestamp: "2026-07-14T12:00:00.000Z",
    });
    const session = "protocol-reconnect-approval";
    const path = `/agents/regression-surgeon-agent/${session}`;
    const requestId = "reviewer-turn-1";
    const input =
      "Investigate the seeded latency regression and prepare the guarded remediation preview.";

    const first = await openAgentChatProtocol(SELF, path);
    first.sendTurn(requestId, input);
    const pending = await first.waitForApproval();
    expect(pending.toolCallId).toMatch(/^deterministic-call-/);
    first.close();

    const reconnected = await openAgentChatProtocol(SELF, path);
    reconnected.requestResume();
    const replayed = await reconnected.waitForApproval();
    reconnected.sendApproval(replayed.toolCallId, true);
    reconnected.sendApproval(replayed.toolCallId, true);
    await reconnected.waitForActionResult();
    reconnected.close();

    const stub = env.REGRESSION_SURGEON_AGENT.getByName(session);
    const persisted = await runInDurableObject<
      RegressionSurgeonAgent,
      { actionParts: unknown[]; userMessages: unknown[] }
    >(stub, async (instance) => {
      await instance.onStart();
      const messages = await instance.getMessages();
      return {
        actionParts: messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-create_draft_pr"),
        userMessages: messages.filter((message) => message.role === "user"),
      };
    });
    expect(persisted.userMessages).toHaveLength(1);
    expect(persisted.actionParts).toHaveLength(1);
    expect(persisted.actionParts[0]).toMatchObject({
      state: "output-available",
      output: { status: "preview", writesPerformed: false },
    });
  }, 30_000);

  it("rejects an unprepared fingerprint after the receipt proposal is prepared", async () => {
    await seedRegressionEvidence();
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("fingerprint-authorization");
    await (
      stub as unknown as { runLocalInvestigation(): Promise<unknown> }
    ).runLocalInvestigation();

    const errorMessage = await runInDurableObject<RegressionSurgeonAgent, string | undefined>(
      stub,
      async (instance) => {
        if (
          instance.state.status !== "investigating" ||
          instance.state.preparedRemediation === undefined
        ) {
          throw new Error("Expected a receipt-prepared remediation.");
        }
        const action = instance.getActions().create_draft_pr;
        if (action === undefined) throw new Error("Expected the receipt-gated action.");
        try {
          await action.config.execute(
            {
              proposalFingerprint: "proposal-v1-fedcba9876543210",
            },
            {} as never,
          );
          return;
        } catch (error) {
          return error instanceof Error ? error.message : "unknown error";
        }
      },
    );

    expect(errorMessage).toMatch(/fingerprint is not authorized/i);
  });
});
