import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformEnvironment, RegressionSurgeonAgent } from "../../workers/platform/src/index";
import { createTelemetryStore } from "../../workers/platform/src/telemetry/store";

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
        maxSteps: instance.maxSteps,
        prompt: instance.getSystemPrompt(),
        tools: Object.keys(instance.getTools()),
        workspaceBash: instance.workspaceBash,
      };
    });

    expect(policy).toEqual({
      actionApproval: undefined,
      actions: [],
      activeTools: [
        "compare_releases",
        "find_slow_traces",
        "inspect_trace",
        "inspect_release",
        "read_repo_files",
      ],
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
                  windowMs: 60_000,
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
                  criticalPath: { durationMs: 380, spanIds: ["request"] },
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
          diff: { path: string; replacementContent: string };
          fingerprint: string;
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
        path: "workers/platform/src/api/health.ts",
        replacementContent: expect.stringMatching(/maximumConcurrentChecks = 2/),
      },
      fingerprint: expect.stringMatching(/^proposal-v1-[0-9a-f]{16}$/),
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
        approvalId: string | undefined;
        proposalFingerprint: string | undefined;
        replacementContent: string | undefined;
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
          approvalId: undefined,
          proposalFingerprint: undefined,
          replacementContent: undefined,
          output: undefined,
          state: undefined,
        };
      }
      const approval = "approval" in part ? part.approval : undefined;
      return {
        approvalId:
          approval !== undefined && typeof approval === "object" && approval !== null
            ? Reflect.get(approval, "id")
            : undefined,
        proposalFingerprint:
          "input" in part && typeof part.input === "object" && part.input !== null
            ? Reflect.get(part.input, "proposalFingerprint")
            : undefined,
        replacementContent:
          "input" in part && typeof part.input === "object" && part.input !== null
            ? Reflect.get(part.input, "replacementContent")
            : undefined,
        output: "output" in part ? part.output : undefined,
        state: typeof part.state === "string" ? part.state : undefined,
      };
    });

    expect(pending).toEqual({
      approvalId: expect.any(String),
      proposalFingerprint: expect.stringMatching(/^proposal-v1-[0-9a-f]{16}$/),
      replacementContent: expect.stringMatching(/maximumConcurrentChecks = 2/),
      output: undefined,
      state: "approval-requested",
    });
  });

  it("rejects a changed proposal after the receipt fingerprint is prepared", async () => {
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
              ...instance.state.preparedRemediation.proposal,
              proposalFingerprint: instance.state.preparedRemediation.fingerprint,
              replacementContent: "a different model-supplied proposal",
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
