import { z } from "zod";

import { serviceDefinitions, serviceIds } from "./services.ts";

export { serviceDefinitions, serviceIds, type ServiceId } from "./services.ts";

export const evidenceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const serviceIdSchema = z.enum(serviceIds);

export const dependencyHealthResponseSchema = z.object({
  serviceId: serviceIdSchema,
  status: z.literal("healthy"),
});

export const serviceHealthResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: serviceIdSchema,
    label: z.string().min(1).max(80),
    status: z.literal("healthy"),
  }),
  z.object({
    id: serviceIdSchema,
    label: z.string().min(1).max(80),
    status: z.literal("unavailable"),
    error: z.object({
      code: z.literal("dependency-unavailable"),
      message: z.literal("Health check unavailable."),
    }),
  }),
]);

export const healthReportSchema = z
  .object({
    interactionId: evidenceIdSchema,
    traceId: evidenceIdSchema,
    releaseId: evidenceIdSchema,
    outcome: z.enum(["healthy", "partial", "failed"]),
    services: z
      .array(serviceHealthResultSchema)
      .length(serviceDefinitions.length)
      .superRefine((services, context) => {
        for (const [index, definition] of serviceDefinitions.entries()) {
          if (services[index]?.id !== definition.id) {
            context.addIssue({
              code: "custom",
              message: "Service results must preserve configured identity and order.",
              path: [index, "id"],
            });
          }
        }
      }),
  })
  .superRefine((report, context) => {
    const healthyCount = report.services.filter((service) => service.status === "healthy").length;
    const expectedOutcome =
      healthyCount === report.services.length
        ? "healthy"
        : healthyCount === 0
          ? "failed"
          : "partial";
    if (report.outcome !== expectedOutcome) {
      context.addIssue({
        code: "custom",
        message: "Report outcome must match its service results.",
        path: ["outcome"],
      });
    }
  });

export type HealthReport = z.infer<typeof healthReportSchema>;
export type ServiceHealthResult = z.infer<typeof serviceHealthResultSchema>;
