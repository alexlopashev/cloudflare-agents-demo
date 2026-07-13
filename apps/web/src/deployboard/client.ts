import {
  evidenceIdSchema,
  healthReportSchema,
  type HealthReport,
} from "../../../../packages/contracts/src/health";

type Fetcher = (request: Request) => Promise<Response>;

export type DeployboardCompletion =
  | { status: "completed"; report: HealthReport }
  | {
      status: "failed";
      interactionId: string;
      error:
        | { code: "refresh-failed"; message: "Health refresh failed." }
        | { code: "metrics-failed"; message: "Metric generation failed." };
    };

export const metricSampleCounts = [5, 10, 20] as const;
export type MetricSampleCount = (typeof metricSampleCounts)[number];

export type MetricBatchProgress = {
  completed: number;
  total: MetricSampleCount;
  latestReport: HealthReport;
};

export type DeployboardMetricBatchOptions = {
  sampleCount: number;
  createInteractionId: () => string;
  fetcher: Fetcher;
  emitCompletion: (completion: DeployboardCompletion) => void;
  onProgress: (progress: MetricBatchProgress) => void;
  now?: () => number;
};

export type DeployboardRefreshOptions = {
  interactionId: string;
  fetcher: Fetcher;
  emitCompletion: (completion: DeployboardCompletion) => void;
  now?: () => number;
  telemetryDelivery?: "background" | "required";
};

export class DeployboardRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployboardRefreshError";
  }
}

export class DeployboardMetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployboardMetricsError";
  }
}

const responseByteLimit = 32_768;

function emitSafely(
  observer: (completion: DeployboardCompletion) => void,
  completion: DeployboardCompletion,
) {
  try {
    observer(completion);
  } catch {
    // Completion observers are deliberately isolated from the user-facing refresh result.
  }
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > responseByteLimit) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

export async function runDeployboardRefresh(
  options: DeployboardRefreshOptions,
): Promise<HealthReport> {
  const interactionId = evidenceIdSchema.safeParse(options.interactionId);
  if (!interactionId.success) throw new DeployboardRefreshError("Health refresh failed.");

  const now = options.now ?? performance.now.bind(performance);
  const startedAtMs = now();
  let report: HealthReport;
  try {
    const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
    const response = await options.fetcher(
      new Request(new URL("/api/health", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: interactionId.data }),
      }),
    );
    if (!response.ok) throw new Error("health API failed");
    const parsed = healthReportSchema.safeParse(await readBoundedResponse(response));
    if (!parsed.success || parsed.data.interactionId !== interactionId.data) {
      throw new Error("health API contract mismatch");
    }
    report = parsed.data;
  } catch {
    const failure = {
      status: "failed" as const,
      interactionId: interactionId.data,
      error: { code: "refresh-failed" as const, message: "Health refresh failed." as const },
    };
    emitSafely(options.emitCompletion, failure);
    throw new DeployboardRefreshError("Health refresh failed.");
  }

  const durationMs = Math.max(0, now() - startedAtMs);
  const outcome =
    report.outcome === "healthy" ? "success" : report.outcome === "partial" ? "partial" : "error";
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const telemetry = options
    .fetcher(
      new Request(new URL("/api/telemetry/ux", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: report.interactionId,
          traceId: report.traceId,
          releaseId: report.releaseId,
          metricName: "service_grid_ready_ms",
          durationMs,
          outcome,
        }),
      }),
    )
    .then((response) => {
      if (!response.ok) throw new Error("telemetry unavailable");
    });
  if (options.telemetryDelivery === "required") {
    try {
      await telemetry;
    } catch {
      emitSafely(options.emitCompletion, {
        status: "failed",
        interactionId: report.interactionId,
        error: { code: "metrics-failed", message: "Metric generation failed." },
      });
      throw new DeployboardMetricsError("Metric generation failed.");
    }
  } else {
    void telemetry.catch(() => undefined);
  }
  emitSafely(options.emitCompletion, { status: "completed", report });
  return report;
}

export async function runDeployboardMetricBatch(options: DeployboardMetricBatchOptions): Promise<{
  sampleCount: MetricSampleCount;
  latestReport: HealthReport;
}> {
  if (!metricSampleCounts.includes(options.sampleCount as MetricSampleCount)) {
    throw new TypeError("Metric sample count is invalid.");
  }
  const sampleCount = options.sampleCount as MetricSampleCount;
  let latestReport: HealthReport | undefined;
  for (let index = 0; index < sampleCount; index += 1) {
    try {
      latestReport = await runDeployboardRefresh({
        interactionId: options.createInteractionId(),
        fetcher: options.fetcher,
        emitCompletion: options.emitCompletion,
        ...(options.now === undefined ? {} : { now: options.now }),
        telemetryDelivery: "required",
      });
    } catch (error) {
      if (error instanceof DeployboardMetricsError) throw error;
      throw new DeployboardMetricsError("Metric generation failed.");
    }
    try {
      options.onProgress({ completed: index + 1, total: sampleCount, latestReport });
    } catch {
      // Progress observers are isolated from acknowledged metric generation.
    }
  }
  if (latestReport === undefined) throw new DeployboardMetricsError("Metric generation failed.");
  return { sampleCount, latestReport };
}
