import { describe, expect, it, vi } from "vitest";

import type { HealthReport } from "../../packages/contracts/src/health";
import {
  DeployboardRefreshError,
  runDeployboardRefresh,
} from "../../apps/web/src/deployboard/client";

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    interactionId: "interaction-1",
    traceId: "trace-1",
    releaseId: "release-good",
    outcome: "healthy",
    services: [
      { id: "api", label: "API gateway", status: "healthy" },
      { id: "jobs", label: "Job runner", status: "healthy" },
      { id: "storage", label: "Object storage", status: "healthy" },
    ],
    ...overrides,
  };
}

describe("Deployboard refresh client", () => {
  it("posts the interaction and emits exactly one validated completion", async () => {
    const fetcher = vi.fn(async (_request: Request) => Response.json(report()));
    const emitCompletion = vi.fn();

    await expect(
      runDeployboardRefresh({ interactionId: "interaction-1", fetcher, emitCompletion }),
    ).resolves.toEqual(report());

    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0]?.[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual({ interactionId: "interaction-1" });
    expect(emitCompletion).toHaveBeenCalledOnce();
    expect(emitCompletion).toHaveBeenCalledWith({ status: "completed", report: report() });
  });

  it("preserves a partial report as a completed interaction", async () => {
    const partial = report({
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
    });
    const emitCompletion = vi.fn();

    await expect(
      runDeployboardRefresh({
        interactionId: "interaction-1",
        fetcher: vi.fn(async () => Response.json(partial)),
        emitCompletion,
      }),
    ).resolves.toEqual(partial);
    expect(emitCompletion).toHaveBeenCalledExactlyOnceWith({
      status: "completed",
      report: partial,
    });
  });

  it("emits one bounded failure for HTTP, transport, malformed, and mismatched responses", async () => {
    const fetchers = [
      vi.fn(async () => new Response("private server detail", { status: 500 })),
      vi.fn(async () => Promise.reject(new Error("private network detail"))),
      vi.fn(async () => new Response("not-json")),
      vi.fn(async () => Response.json(report({ interactionId: "other-interaction" }))),
      vi.fn(async () =>
        Response.json(
          report({
            outcome: "healthy",
            services: [
              { id: "api", label: "API gateway", status: "healthy" },
              {
                id: "jobs",
                label: "Job runner",
                status: "unavailable",
                error: {
                  code: "dependency-unavailable",
                  message: "Health check unavailable.",
                },
              },
              { id: "storage", label: "Object storage", status: "healthy" },
            ],
          }),
        ),
      ),
    ];

    for (const fetcher of fetchers) {
      const emitCompletion = vi.fn();
      await expect(
        runDeployboardRefresh({ interactionId: "interaction-1", fetcher, emitCompletion }),
      ).rejects.toEqual(new DeployboardRefreshError("Health refresh failed."));
      expect(emitCompletion).toHaveBeenCalledOnce();
      expect(emitCompletion).toHaveBeenCalledWith({
        status: "failed",
        interactionId: "interaction-1",
        error: { code: "refresh-failed", message: "Health refresh failed." },
      });
      expect(JSON.stringify(emitCompletion.mock.calls)).not.toContain("private");
    }
  });

  it("does not let a completion observer failure break a valid refresh", async () => {
    const emitCompletion = vi.fn(() => {
      throw new Error("observer failed");
    });

    await expect(
      runDeployboardRefresh({
        interactionId: "interaction-1",
        fetcher: vi.fn(async () => Response.json(report())),
        emitCompletion,
      }),
    ).resolves.toEqual(report());
    expect(emitCompletion).toHaveBeenCalledOnce();
  });
});
