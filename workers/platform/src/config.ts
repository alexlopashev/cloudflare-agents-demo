import { z } from "zod";

import { parseAiGatewayId } from "../../../packages/contracts/src/ai-gateway";

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "Git SHA is invalid.");
const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/);
const versionIdSchema = z.string().min(1, "Worker version is required.").max(128);
const modelModeSchema = z.enum(["fake", "workers-ai"]);

export type ExternalConfigurationInput = {
  aiGatewayId?: string | undefined;
  gitSha: string;
  githubOwner: string;
  githubRepo: string;
  githubToken?: string;
  githubWriteEnabled: string;
  modelMode: string;
  versionMetadata: { id: string; timestamp?: string };
};

export type ExternalConfiguration = {
  aiGatewayId?: string;
  github: AgentConfiguration["github"];
  modelMode: AgentConfiguration["modelMode"];
  runtime: RuntimeIdentity;
};

export type AgentConfiguration = {
  aiGatewayId?: string;
  github: {
    owner: string;
    repo: string;
    token?: string;
    writeEnabled: boolean;
  };
  modelMode: z.infer<typeof modelModeSchema>;
};

export type RuntimeIdentity = {
  deployedAtMs: number;
  gitSha: string;
  versionId: string;
};

export function composeAgentConfiguration(
  input: Omit<ExternalConfigurationInput, "gitSha" | "versionMetadata">,
): AgentConfiguration {
  const owner = repositoryNameSchema.parse(input.githubOwner);
  const repo = repositoryNameSchema.parse(input.githubRepo);
  const modelMode = modelModeSchema.parse(input.modelMode);
  const aiGatewayId = modelMode === "workers-ai" ? parseAiGatewayId(input.aiGatewayId) : undefined;
  if (input.githubWriteEnabled !== "true" && input.githubWriteEnabled !== "false") {
    throw new TypeError("GitHub write posture is invalid.");
  }
  const token = input.githubToken?.trim();
  const normalizedToken = token === undefined || token.length === 0 ? undefined : token;
  const writeEnabled = input.githubWriteEnabled === "true";
  if (writeEnabled && normalizedToken === undefined) {
    throw new TypeError("GitHub writes require an explicit non-empty scoped token.");
  }
  return {
    ...(aiGatewayId === undefined ? {} : { aiGatewayId }),
    github: {
      owner,
      repo,
      ...(normalizedToken === undefined ? {} : { token: normalizedToken }),
      writeEnabled,
    },
    modelMode,
  };
}

export function composeRuntimeIdentity(
  input: Pick<ExternalConfigurationInput, "gitSha" | "versionMetadata">,
): RuntimeIdentity {
  const gitSha = gitShaSchema.parse(input.gitSha);
  const versionId = versionIdSchema.parse(input.versionMetadata.id);
  const deployedAtMs = Date.parse(input.versionMetadata.timestamp ?? "");
  if (!Number.isFinite(deployedAtMs)) {
    throw new TypeError("Worker deployment timestamp is invalid.");
  }
  return { deployedAtMs, gitSha, versionId };
}

export function composeExternalConfiguration(
  input: ExternalConfigurationInput,
): ExternalConfiguration {
  return {
    ...composeAgentConfiguration(input),
    runtime: composeRuntimeIdentity(input),
  };
}
