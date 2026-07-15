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
const liveWorkerByteBudget = 7 * 1_024 * 1_024;
const clientByteBudget = 768 * 1_024;

function javaScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return javaScriptFiles(path);
    return entry.isFile() && path.endsWith(".js") ? [path] : [];
  });
}

function totalFileBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return total + totalFileBytes(path);
    return entry.isFile() ? total + statSync(path).size : total;
  }, 0);
}

export function assertLiveBundle(directory: string, clientDirectory?: string): void {
  const root = resolve(directory);
  if (!statSync(root).isDirectory()) throw new TypeError("Live bundle path must be a directory.");
  const files = javaScriptFiles(root);
  if (files.length === 0) throw new TypeError("Live bundle contains no JavaScript output.");
  const workerBytes = files.reduce((total, file) => total + statSync(file).size, 0);
  if (workerBytes > liveWorkerByteBudget) {
    throw new Error("Worker bundle exceeds its byte budget.");
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const marker = prohibitedMarkers.find((candidate) => source.includes(candidate));
    if (marker !== undefined) {
      throw new Error(`Live bundle contains prohibited marker: ${marker}`);
    }
  }
  if (clientDirectory === undefined) throw new TypeError("Client bundle path is required.");
  const clientRoot = resolve(clientDirectory);
  if (!statSync(clientRoot).isDirectory()) throw new TypeError("Client bundle path is invalid.");
  if (totalFileBytes(clientRoot) > clientByteBudget) {
    throw new Error("Client bundle exceeds its byte budget.");
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  const clientDirectory = process.argv[3];
  if (directory === undefined) throw new TypeError("Live bundle path is required.");
  if (clientDirectory === undefined) throw new TypeError("Client bundle path is required.");
  assertLiveBundle(directory, clientDirectory);
  console.log("Live production bundle and client assets satisfy composition and byte budgets.");
}
