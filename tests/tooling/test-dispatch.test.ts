import { describe, expect, it } from "vitest";

import { buildTestCommands } from "../../scripts/test";

describe("repository test dispatch", () => {
  it("sends each target only to its compatible test layer", () => {
    expect(buildTestCommands(["tests/telemetry/traces.test.ts"], false)).toEqual([
      {
        command: "vitest",
        args: ["run", "--config", "vitest.config.ts", "tests/telemetry/traces.test.ts"],
      },
    ]);
    expect(buildTestCommands(["tests/agent/investigation-agent.worker.test.ts"], false)).toEqual([
      {
        command: "node",
        args: ["scripts/run-worker-tests.ts", "tests/agent/investigation-agent.worker.test.ts"],
      },
    ]);
    expect(buildTestCommands(["tests/foundation/foundation-contract.test.mjs"], false)).toEqual([
      {
        command: "node",
        args: ["--test", "tests/foundation/foundation-contract.test.mjs"],
      },
    ]);
  });

  it("keeps mixed targets grouped by compatible layer without broad discovery", () => {
    expect(
      buildTestCommands(
        [
          "tests/platform/routing.test.ts",
          "tests/remediation/action.worker.test.ts",
          "tests/foundation/foundation-contract.test.mjs",
        ],
        false,
      ),
    ).toEqual([
      {
        command: "node",
        args: ["--test", "tests/foundation/foundation-contract.test.mjs"],
      },
      {
        command: "vitest",
        args: ["run", "--config", "vitest.config.ts", "tests/platform/routing.test.ts"],
      },
      {
        command: "node",
        args: ["scripts/run-worker-tests.ts", "tests/remediation/action.worker.test.ts"],
      },
    ]);
  });

  it("uses one two-project Vitest workspace for ordinary and Worker watch mode", () => {
    expect(buildTestCommands([], true)).toEqual([
      {
        command: "vitest",
        args: ["--config", "vitest.workspace.config.ts"],
      },
    ]);
  });

  it("rejects paths that are not repository test targets", () => {
    expect(() => buildTestCommands(["workers/platform/src/index.ts"], false)).toThrow(
      /test target/i,
    );
  });
});
