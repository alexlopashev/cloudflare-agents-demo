import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const auditedIncompleteMap =
  /^Sourcemap for ".*[\\/]node_modules[\\/]\.pnpm[\\/](?:@workflow\+serde@4\.1\.0-beta\.2|@modelcontextprotocol\+sdk@1\.29\.0_[^\\/]+|cron-schedule@6\.0\.0)[\\/]node_modules[\\/](?:@workflow[\\/]serde|@modelcontextprotocol[\\/]sdk|cron-schedule)[\\/].*" points to missing source files$/;

export function isKnownIncompleteDependencySourcemap(line: string): boolean {
  return auditedIncompleteMap.test(line);
}

function filterAuditedWarnings(output: string): string {
  return output
    .split("\n")
    .filter((line) => !isKnownIncompleteDependencySourcemap(line))
    .join("\n");
}

function run(): void {
  const vitestEntrypoint = new URL("../node_modules/vitest/vitest.mjs", import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    [vitestEntrypoint, "run", "--config", "vitest.worker.config.ts", ...process.argv.slice(2)],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  process.stdout.write(filterAuditedWarnings(result.stdout ?? ""));
  process.stderr.write(filterAuditedWarnings(result.stderr ?? ""));
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Worker tests terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) run();
