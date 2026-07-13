import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HealthReport } from "../../packages/contracts/src/health";
import {
  DeployboardView,
  type MetricGenerationState,
  type DeployboardViewState,
} from "../../apps/web/src/deployboard/Deployboard";

function render(
  state: DeployboardViewState,
  metrics: MetricGenerationState = { status: "idle" },
): string {
  return renderToStaticMarkup(
    <DeployboardView
      metrics={metrics}
      onGenerateMetrics={() => undefined}
      onRefresh={() => undefined}
      onSampleCountChange={() => undefined}
      sampleCount={5}
      state={state}
    />,
  );
}

function partialReport(): HealthReport {
  return {
    interactionId: "interaction-1",
    traceId: "trace-1",
    releaseId: "release-good",
    outcome: "partial",
    services: [
      { id: "api", label: "API gateway", status: "healthy" },
      {
        id: "jobs",
        label: "Job runner",
        status: "unavailable",
        error: { code: "dependency-unavailable", message: "Health check unavailable." },
      },
      { id: "storage", label: "Object storage", status: "healthy" },
    ],
  };
}

describe("DeployboardView", () => {
  it("renders a keyboard-native refresh action and stable service grid before loading", () => {
    const markup = render({ status: "idle" });

    expect(markup).toMatch(/<button[^>]*type="button"/);
    expect(markup).toContain("Refresh services");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("API gateway");
    expect(markup).toContain("Job runner");
    expect(markup).toContain("Object storage");
    expect(markup.match(/Not checked/g)).toHaveLength(3);
    expect(markup).toContain("Generate metrics data");
    expect(markup).toMatch(/optional telemetry ingestion/i);
    expect(markup).toMatch(/does not select or modify the configured incident/i);
    expect(markup.match(/<option/g)).toHaveLength(3);
    expect(markup).toContain('<option value="5" selected="">5 samples</option>');
    expect(markup).toContain('<option value="10">10 samples</option>');
    expect(markup).toContain('<option value="20">20 samples</option>');
    expect(markup).toContain("Generate metrics");
  });

  it("disables refresh and exposes busy state while one interaction is active", () => {
    const markup = render({ status: "loading" });

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Refreshing services");
  });

  it("keeps partial dependency results understandable with trace and release evidence", () => {
    const markup = render({ status: "ready", report: partialReport() });

    expect(markup).toContain("2 of 3 services healthy");
    expect(markup).toContain("Health check unavailable.");
    expect(markup).toContain("trace-1");
    expect(markup).toContain("release-good");
  });

  it("announces a failed refresh without discarding the service grid", () => {
    const markup = render({ status: "error" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Refresh failed");
    expect(markup.match(/Unavailable/g)).toHaveLength(3);
  });

  it("announces an all-dependency failure from a completed report", () => {
    const failed = partialReport();
    failed.outcome = "failed";
    failed.services = failed.services.map((service) => ({
      id: service.id,
      label: service.label,
      status: "unavailable",
      error: { code: "dependency-unavailable", message: "Health check unavailable." },
    }));
    const markup = render({ status: "ready", report: failed });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("0 of 3 services healthy");
  });

  it("reports bounded metric-generation progress and disables overlapping actions", () => {
    const markup = render({ status: "loading" }, { status: "generating", completed: 2, total: 5 });

    expect(markup).toContain('value="2"');
    expect(markup).toContain('max="5"');
    expect(markup).toContain("2 of 5 measured interactions recorded");
    expect(markup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps completed progress visible and announces a partial generation failure", () => {
    const markup = render({ status: "idle" }, { status: "error", completed: 3, total: 10 });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Stopped after 3 of 10 measured interactions");
  });
});
