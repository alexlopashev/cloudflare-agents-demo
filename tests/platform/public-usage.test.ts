import { describe, expect, it, vi } from "vitest";

import {
  checkPublicUsage,
  PUBLIC_USAGE_RETRY_AFTER_SECONDS,
} from "../../workers/platform/src/public-usage";

describe("public usage policy", () => {
  it("leaves local deterministic use untouched without reading a limiter", async () => {
    const limiter = { limit: vi.fn() };

    await expect(checkPublicUsage("local", limiter)).resolves.toEqual({ allowed: true });
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("allows, exhausts, and allows again when the platform window resets", async () => {
    const limiter = {
      limit: vi
        .fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true }),
    };

    await expect(checkPublicUsage("rate-limited", limiter)).resolves.toEqual({ allowed: true });
    await expect(checkPublicUsage("rate-limited", limiter)).resolves.toEqual({
      allowed: false,
      code: "public-usage-rate-limited",
      retryAfterSeconds: PUBLIC_USAGE_RETRY_AFTER_SECONDS,
      status: 429,
    });
    await expect(checkPublicUsage("rate-limited", limiter)).resolves.toEqual({ allowed: true });
    expect(limiter.limit).toHaveBeenCalledTimes(3);
    expect(limiter.limit).toHaveBeenNthCalledWith(1, { key: "public" });
  });

  it("fails closed for an operator shutdown or an unavailable limiter", async () => {
    const unavailable = { limit: vi.fn(async () => Promise.reject(new Error("binding failed"))) };
    const malformed = {
      limit: vi.fn(async () => ({ success: "not-a-boolean" })) as never,
    };

    await expect(checkPublicUsage("disabled", unavailable)).resolves.toEqual({
      allowed: false,
      code: "public-usage-disabled",
      status: 503,
    });
    expect(unavailable.limit).not.toHaveBeenCalled();
    await expect(checkPublicUsage("rate-limited", unavailable)).resolves.toEqual({
      allowed: false,
      code: "public-usage-unavailable",
      status: 503,
    });
    await expect(checkPublicUsage("rate-limited", malformed)).resolves.toEqual({
      allowed: false,
      code: "public-usage-unavailable",
      status: 503,
    });
  });
});
