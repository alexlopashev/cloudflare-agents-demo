import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const prohibitedMarkers = [
  "ai/test",
  "packages/test-fixtures",
  "MockLanguageModelV3",
  "regression-surgeon-deterministic",
  "runaway tool loop fixture",
  "Deterministic remediation cannot write",
] as const;

function javaScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return javaScriptFiles(path);
    return entry.isFile() && path.endsWith(".js") ? [path] : [];
  });
}

export function assertLiveBundle(directory: string): void {
  const root = resolve(directory);
  if (!statSync(root).isDirectory()) throw new TypeError("Live bundle path must be a directory.");
  const files = javaScriptFiles(root);
  if (files.length === 0) throw new TypeError("Live bundle contains no JavaScript output.");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const marker = prohibitedMarkers.find((candidate) => source.includes(candidate));
    if (marker !== undefined) {
      throw new Error(`Live bundle contains prohibited marker: ${marker}`);
    }
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (directory === undefined) throw new TypeError("Live bundle path is required.");
  assertLiveBundle(directory);
  console.log("Live production bundle excludes deterministic test composition.");
}
