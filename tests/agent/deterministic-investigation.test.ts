import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { createDeterministicModel } from "../../workers/platform/src/agent/model";
import { remediationFixture } from "../../packages/test-fixtures/src/remediation";

describe("deterministic investigation model", () => {
  it("performs the complete evidence sequence before producing a structured report", async () => {
    const calls: string[] = [];
    const tools = {
      compare_releases: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => {
          calls.push("compare_releases");
          return { status: "ready", baseline: { p75Ms: 111 }, candidate: { p75Ms: 443 } };
        },
      }),
      find_slow_traces: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => {
          calls.push("find_slow_traces");
          return [{ traceId: "regression-trace-7", releaseId: "regression-sequential" }];
        },
      }),
      inspect_trace: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => {
          calls.push("inspect_trace");
          return {
            trace: { traceId: "regression-trace-7" },
            criticalPath: { diagnostics: [], spanIds: ["request"], wallTimeMs: 443 },
          };
        },
      }),
      inspect_release: tool({
        inputSchema: z.object({ versionId: z.string() }),
        execute: async () => {
          calls.push("inspect_release");
          return {
            release: { commitSha: "d591869a8ef995f1835ef80152f4de085b10255b" },
            pullRequest: { status: "found", number: 19 },
          };
        },
      }),
      read_repo_files: tool({
        inputSchema: z.object({ commitSha: z.string(), paths: z.array(z.string()) }),
        execute: async () => {
          calls.push("read_repo_files");
          return [{ content: 'loadingMode === "sequential"' }];
        },
      }),
    };
    const result = streamText({
      model: createDeterministicModel(),
      prompt: "Investigate the measured latency regression.",
      tools,
      stopWhen: stepCountIs(8),
    });

    const text = await result.text;

    expect(calls).toEqual([
      "compare_releases",
      "find_slow_traces",
      "inspect_trace",
      "inspect_release",
      "read_repo_files",
    ]);
    expect(text).toMatch(/Evidence[\s\S]+regression-trace-7[\s\S]+d591869[\s\S]+PR #19/);
    expect(text).toMatch(/baseline-concurrent p75 111 ms; regression-sequential p75 443 ms/);
    expect(text).toMatch(/critical-path wall time is approximately 443 ms/);
    expect(text).toMatch(/Inference[\s\S]+Confidence[\s\S]+Unknowns/);
    expect(calls.indexOf("read_repo_files")).toBeLessThan(text.length);
  });

  it("keeps bounded tool failure visible and refuses a confident causal claim", async () => {
    const error = {
      status: "error" as const,
      code: "unavailable" as const,
      message: "Evidence source is unavailable." as const,
    };
    const tools = {
      compare_releases: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => error,
      }),
      find_slow_traces: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => error,
      }),
      inspect_trace: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => error,
      }),
      inspect_release: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => error,
      }),
      read_repo_files: tool({
        inputSchema: z.object({}).passthrough(),
        execute: async () => error,
      }),
    };
    const result = streamText({
      model: createDeterministicModel(),
      prompt: "Investigate the measured latency regression.",
      tools,
      stopWhen: stepCountIs(8),
    });

    const text = await result.text;

    expect(text).toMatch(/Evidence[\s\S]+unavailable[\s\S]+Confidence[\s\S]+Low/i);
    expect(text).not.toMatch(/likely cause/i);
  });

  it("proposes the bounded fix only after existing evidence and reports preview-only execution", async () => {
    const execute = vi.fn(async () => ({
      status: "preview" as const,
      writesPerformed: false as const,
      branch: "regression-surgeon/0123456789abcdef",
    }));
    const result = streamText({
      model: createDeterministicModel(),
      prompt: `Existing report:
## Evidence
Representative trace: scenario-trace-39. Immutable source: commit ${remediationFixture.expectedBaseSha}; PR #19.
Prepare the guarded remediation preview.`,
      tools: {
        create_draft_pr: tool({
          inputSchema: z.object({}).passthrough(),
          execute,
        }),
      },
      stopWhen: stepCountIs(8),
    });

    const text = await result.text;

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ...remediationFixture,
        incident: expect.objectContaining({ traceId: "scenario-trace-39" }),
      }),
      expect.anything(),
    );
    expect(text).toMatch(/validated preview/i);
    expect(text).toMatch(/no GitHub write/i);
    expect(text).toMatch(/Evidence[\s\S]+Inference[\s\S]+Confidence[\s\S]+Unknowns/i);
    expect(text).not.toMatch(/created draft PR/i);
  });
});
