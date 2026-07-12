import { describe, expect, it, vi } from "vitest";

import { verifyLocalStack } from "../../scripts/local-stack-contract";

describe("local stack contract", () => {
  it("requires both experiences, the auxiliary service, and runtime metadata", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/app" || path === "/investigator") {
        return new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } });
      }
      if (path === "/api/health") {
        return Response.json({ service: "health-service", status: "ok" });
      }
      if (path === "/api/runtime") return Response.json({ mode: "fake", versionId: "local" });
      return new Response("Not found", { status: 404 });
    });

    await expect(verifyLocalStack("http://127.0.0.1:5173", fetcher)).resolves.toEqual({
      health: "ok",
      mode: "fake",
      routes: ["/app", "/investigator"],
    });
  });

  it("fails when the service binding does not prove the auxiliary worker responded", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/app" || path === "/investigator") {
        return new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } });
      }
      return Response.json({ service: "platform", status: "ok" });
    });

    await expect(verifyLocalStack("http://127.0.0.1:5173", fetcher)).rejects.toThrow(
      "health-service",
    );
  });
});
