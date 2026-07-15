import { describe, expect, it } from "vitest";

import { composeExternalConfiguration } from "../../workers/platform/src/config";

const validInput = {
  aiGatewayId: "regression-surgeon",
  versionMetadata: { id: "worker-version-1", timestamp: "2026-07-14T12:00:00.000Z" },
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  githubOwner: "alexlopashev",
  githubRepo: "cloudflare-agents-demo",
  githubWriteEnabled: "false",
  modelMode: "workers-ai",
  publicUsageMode: "rate-limited",
};

describe("external runtime composition", () => {
  it.each([
    undefined,
    "",
    "   ",
    "Invalid Gateway",
    "a".repeat(65),
  ])("requires one valid named gateway in live mode (%s)", (aiGatewayId) => {
    expect(() =>
      composeExternalConfiguration({
        ...validInput,
        ...(aiGatewayId === undefined ? { aiGatewayId: undefined } : { aiGatewayId }),
      }),
    ).toThrow(/gateway/i);
  });

  it("keeps deterministic mode independent of AI Gateway", () => {
    const configuration = composeExternalConfiguration({
      ...validInput,
      aiGatewayId: undefined,
      modelMode: "fake",
      publicUsageMode: "local",
    });

    expect(configuration.aiGatewayId).toBeUndefined();
  });

  it("rejects an unbounded local posture for live Workers AI", () => {
    expect(() => composeExternalConfiguration({ ...validInput, publicUsageMode: "local" })).toThrow(
      /unbounded local/i,
    );
  });

  it.each([undefined, "", "   "])("normalizes an absent GitHub token once (%s)", (token) => {
    const configuration = composeExternalConfiguration({
      ...validInput,
      ...(token === undefined ? {} : { githubToken: token }),
    });

    expect(configuration.github).toEqual({
      owner: "alexlopashev",
      repo: "cloudflare-agents-demo",
      writeEnabled: false,
    });
  });

  it("requires a normalized scoped token before enabling writes", () => {
    expect(() =>
      composeExternalConfiguration({
        ...validInput,
        githubToken: "  ",
        githubWriteEnabled: "true",
      }),
    ).toThrow(/token/i);

    expect(
      composeExternalConfiguration({
        ...validInput,
        githubToken: "  scoped-token  ",
        githubWriteEnabled: "true",
      }).github,
    ).toEqual({
      owner: "alexlopashev",
      repo: "cloudflare-agents-demo",
      token: "scoped-token",
      writeEnabled: true,
    });
  });

  it.each([
    { gitSha: "", label: "Git SHA" },
    { gitSha: "not-a-sha", label: "Git SHA" },
    { versionMetadata: { id: "", timestamp: "2026-07-14T12:00:00.000Z" }, label: "version" },
    { versionMetadata: { id: "worker-version-1" }, label: "timestamp" },
    { versionMetadata: { id: "worker-version-1", timestamp: "not-a-date" }, label: "timestamp" },
  ])("rejects malformed runtime identity: $label", (invalid) => {
    expect(() => composeExternalConfiguration({ ...validInput, ...invalid })).toThrow(
      new RegExp(invalid.label, "i"),
    );
  });
});
