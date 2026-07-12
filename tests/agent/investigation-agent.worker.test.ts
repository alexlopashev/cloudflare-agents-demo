import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
      actionApproval: true,
      actions: ["create_draft_pr"],
      activeTools: ["query_telemetry", "inspect_release", "read_repo_files", "create_draft_pr"],
      maxSteps: 16,
      prompt: expect.stringMatching(/evidence[\s\S]+inference[\s\S]+confidence[\s\S]+unknowns/i),
      tools: ["query_telemetry", "inspect_release", "read_repo_files"],
      workspaceBash: false,
    });
    expect(policy.prompt).toMatch(/do not repeat a successful tool operation/i);
    expect(policy.prompt).not.toMatch(
      /Never claim\s+that a write, deployment, rollback, or pull-request creation occurred\./,
    );
  });

  it("exposes the deterministic investigation through its local RPC boundary", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("local-rpc-boundary") as unknown as {
      runLocalInvestigation(): Promise<{ report: string; toolTypes: string[] }>;
    };

    const result = await stub.runLocalInvestigation();

    expect(result.toolTypes).toEqual([
      "tool-query_telemetry",
      "tool-query_telemetry",
      "tool-query_telemetry",
      "tool-inspect_release",
      "tool-read_repo_files",
    ]);
    expect(result.report).toMatch(/Evidence[\s\S]+Inference[\s\S]+Confidence[\s\S]+Unknowns/i);
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
      "tool-query_telemetry",
      "tool-query_telemetry",
      "tool-query_telemetry",
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
    expect(new Set(toolTypes)).toEqual(new Set(["tool-query_telemetry"]));
  });

  it("parks the guarded remediation action until explicit human approval", async () => {
    await seedRegressionEvidence();
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("approval-gated-remediation");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const pending = await runInDurableObject<
      RegressionSurgeonAgent,
      {
        approvalId: string | undefined;
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
        output: "output" in part ? part.output : undefined,
        state: typeof part.state === "string" ? part.state : undefined,
      };
    });

    expect(pending).toEqual({
      approvalId: expect.any(String),
      output: undefined,
      state: "approval-requested",
    });
  });
});
