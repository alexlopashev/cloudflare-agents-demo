import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { RepositoryConnectorError } from "../github";
import { TelemetryBoundsError } from "../telemetry/store";

type TelemetryEvidence = {
  compareReleases(input: {
    baselineReleaseId: string;
    candidateReleaseId: string;
    windowMs: number;
  }): Promise<unknown>;
  findSlowTraces(input: {
    releaseId?: string;
    sinceMs: number;
    untilMs: number;
    limit: number;
  }): Promise<unknown>;
  getTraceDetail(traceId: string): Promise<unknown>;
};

type RepositoryEvidence = {
  inspectRelease(versionId: string): Promise<unknown>;
  readFiles(input: { commitSha: string; paths: readonly string[] }): Promise<unknown>;
};

export type InvestigationEvidenceServices = {
  telemetry: TelemetryEvidence;
  repository: RepositoryEvidence;
};

const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const queryTelemetrySchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("compare-releases"),
      baselineReleaseId: evidenceId,
      candidateReleaseId: evidenceId,
      windowMs: z
        .number()
        .int()
        .positive()
        .max(30 * 24 * 60 * 60 * 1_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("find-slow-traces"),
      releaseId: evidenceId.optional(),
      sinceMs: z.number().int().nonnegative(),
      untilMs: z.number().int().positive(),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  z.object({ operation: z.literal("inspect-trace"), traceId: evidenceId }).strict(),
]);
const inspectReleaseSchema = z.object({ versionId: evidenceId }).strict();
const readFilesSchema = z
  .object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    paths: z.array(z.string().min(1).max(512)).min(1).max(4),
  })
  .strict();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function truncateResult(value: unknown, maxResultBytes: number): unknown {
  const serialized = JSON.stringify(value);
  const bytes = encoder.encode(serialized);
  if (bytes.byteLength <= maxResultBytes) return value;

  const makeResult = (preview: string) => ({
    status: "truncated" as const,
    originalBytes: bytes.byteLength,
    preview,
    note: "Tool result exceeded the model-context byte limit.",
  });
  let lower = 0;
  let upper = Math.min(bytes.byteLength, maxResultBytes);
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const preview = decoder.decode(bytes.slice(0, candidate));
    if (byteLength(makeResult(preview)) <= maxResultBytes) lower = candidate;
    else upper = candidate - 1;
  }
  return makeResult(decoder.decode(bytes.slice(0, lower)));
}

function boundedError(error: unknown) {
  if (error instanceof RepositoryConnectorError || error instanceof TelemetryBoundsError) {
    return {
      status: "error" as const,
      code: "code" in error && typeof error.code === "string" ? error.code : "limit-exceeded",
      message: error.message.slice(0, 240),
    };
  }
  return {
    status: "error" as const,
    code: "unavailable" as const,
    message: "Evidence source is unavailable." as const,
  };
}

async function executeBounded(
  operation: () => Promise<unknown>,
  maxResultBytes: number,
): Promise<unknown> {
  try {
    return truncateResult(await operation(), maxResultBytes);
  } catch (error) {
    return truncateResult(boundedError(error), maxResultBytes);
  }
}

export function createInvestigationTools(
  services: InvestigationEvidenceServices,
  options: { maxResultBytes?: number } = {},
): ToolSet {
  const maxResultBytes = options.maxResultBytes ?? 16_384;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 256 || maxResultBytes > 32_768) {
    throw new TypeError("Tool result byte policy is invalid.");
  }

  return {
    query_telemetry: tool({
      description:
        "Compare measured releases, find slow traces, or inspect one trace through fixed bounded operations. Never accepts SQL.",
      inputSchema: queryTelemetrySchema,
      execute: async (rawInput) => {
        const input = queryTelemetrySchema.parse(rawInput);
        if (input.operation === "compare-releases") {
          return executeBounded(() => services.telemetry.compareReleases(input), maxResultBytes);
        }
        if (input.operation === "find-slow-traces") {
          if (input.untilMs <= input.sinceMs) throw new TypeError("Trace time window is invalid.");
          const query = {
            sinceMs: input.sinceMs,
            untilMs: input.untilMs,
            limit: input.limit,
            ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
          };
          return executeBounded(() => services.telemetry.findSlowTraces(query), maxResultBytes);
        }
        return executeBounded(
          () => services.telemetry.getTraceDetail(input.traceId),
          maxResultBytes,
        );
      },
    }),
    inspect_release: tool({
      description:
        "Resolve one measured release to its immutable Git commit, associated pull request, and bounded changed-file evidence.",
      inputSchema: inspectReleaseSchema,
      execute: async (rawInput) => {
        const input = inspectReleaseSchema.parse(rawInput);
        return executeBounded(
          () => services.repository.inspectRelease(input.versionId),
          maxResultBytes,
        );
      },
    }),
    read_repo_files: tool({
      description:
        "Read a small allowlisted set of repository files at one full immutable commit SHA.",
      inputSchema: readFilesSchema,
      execute: async (rawInput) => {
        const input = readFilesSchema.parse(rawInput);
        return executeBounded(() => services.repository.readFiles(input), maxResultBytes);
      },
    }),
  };
}
