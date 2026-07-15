import { z } from "zod";

export const AI_GATEWAY_ID = "regression-surgeon";

const aiGatewayIdSchema = z
  .string()
  .trim()
  .min(1, "AI Gateway ID is required.")
  .max(64, "AI Gateway ID is too long.")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "AI Gateway ID is invalid.");

export function parseAiGatewayId(value: unknown): string {
  const parsed = aiGatewayIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("AI Gateway ID is invalid.");
  return parsed.data;
}
