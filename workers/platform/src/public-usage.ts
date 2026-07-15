export const PUBLIC_USAGE_RETRY_AFTER_SECONDS = 60;

export type PublicUsageMode = "disabled" | "local" | "rate-limited";

export type PublicUsageLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type PublicUsageOptions = {
  limiter?: PublicUsageLimiter;
  mode: PublicUsageMode;
};

export type PublicUsageDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "public-usage-disabled" | "public-usage-rate-limited" | "public-usage-unavailable";
      retryAfterSeconds?: number;
      status: 429 | 503;
    };

export async function checkPublicUsage(
  mode: PublicUsageMode,
  limiter?: PublicUsageLimiter,
): Promise<PublicUsageDecision> {
  if (mode === "local") return { allowed: true };
  if (mode === "disabled") {
    return { allowed: false, code: "public-usage-disabled", status: 503 };
  }
  if (limiter === undefined) {
    return { allowed: false, code: "public-usage-unavailable", status: 503 };
  }
  try {
    const result = await limiter.limit({ key: "public" });
    if (result.success === true) return { allowed: true };
    if (result.success === false) {
      return {
        allowed: false,
        code: "public-usage-rate-limited",
        retryAfterSeconds: PUBLIC_USAGE_RETRY_AFTER_SECONDS,
        status: 429,
      };
    }
    return { allowed: false, code: "public-usage-unavailable", status: 503 };
  } catch {
    return { allowed: false, code: "public-usage-unavailable", status: 503 };
  }
}

export function publicUsageDenialMessage(
  decision: Exclude<PublicUsageDecision, { allowed: true }>,
  subject: string,
): string {
  if (decision.code === "public-usage-rate-limited") {
    return `${subject} limit reached. Retry in ${decision.retryAfterSeconds} seconds.`;
  }
  if (decision.code === "public-usage-disabled") {
    return `${subject} is temporarily disabled by the operator.`;
  }
  return `${subject} is temporarily unavailable because its usage limit could not be verified.`;
}
