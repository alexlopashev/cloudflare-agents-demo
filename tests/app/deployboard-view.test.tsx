import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HealthReport } from "../../packages/contracts/src/health";
import {
  DeployboardView,
  type DeployboardViewState,
} from "../../apps/web/src/deployboard/Deployboard";

function render(state: DeployboardViewState): string {
  return renderToStaticMarkup(<DeployboardView onRefresh={() => undefined} state={state} />);
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
});
