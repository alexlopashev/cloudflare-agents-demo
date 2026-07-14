import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type TestCommand = {
  command: "node" | "vitest";
  args: string[];
};

function classifyTarget(target: string): "foundation" | "ordinary" | "worker" {
  if (/^tests\/.+\.test\.mjs$/.test(target)) return "foundation";
  if (/^tests\/.+\.worker\.test\.tsx?$/.test(target)) return "worker";
  if (/^tests\/.+\.test\.tsx?$/.test(target)) return "ordinary";
  throw new TypeError(`Unsupported repository test target: ${target}`);
}

export function buildTestCommands(targets: string[], watch: boolean): TestCommand[] {
  if (watch) {
    if (targets.some((target) => classifyTarget(target) === "foundation")) {
      throw new TypeError("Foundation Node tests do not support repository watch mode.");
    }
    return [
      {
        command: "vitest",
        args: ["--config", "vitest.workspace.config.ts", ...targets],
      },
    ];
  }

  const selected = {
    foundation: [] as string[],
    ordinary: [] as string[],
    worker: [] as string[],
  };
  for (const target of targets) selected[classifyTarget(target)].push(target);
  if (targets.length === 0) {
    selected.foundation.push(...globSync("tests/**/*.test.mjs"));
  }

  const commands: TestCommand[] = [];
  if (selected.foundation.length > 0) {
    commands.push({ command: "node", args: ["--test", ...selected.foundation] });
  }
  if (targets.length === 0 || selected.ordinary.length > 0) {
    commands.push({
      command: "vitest",
      args: ["run", "--config", "vitest.config.ts", ...selected.ordinary],
    });
  }
  if (targets.length === 0 || selected.worker.length > 0) {
    commands.push({
      command: "node",
      args: ["scripts/run-worker-tests.ts", ...selected.worker],
    });
  }
  return commands;
}

function runCommand(command: TestCommand): void {
  const vitestEntrypoint = new URL("../node_modules/vitest/vitest.mjs", import.meta.url).pathname;
  const args = command.command === "vitest" ? [vitestEntrypoint, ...command.args] : command.args;
  const result = spawnSync(process.execPath, args, {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Test command terminated by ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function run(): void {
  const args = process.argv.slice(2);
  const watch = args[0] === "--watch";
  const targets = watch ? args.slice(1) : args;
  for (const command of buildTestCommands(targets, watch)) runCommand(command);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) run();
