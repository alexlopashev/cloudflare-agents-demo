export const serviceIds = ["api", "jobs", "storage"] as const;

export const serviceDefinitions = [
  { id: "api", label: "API gateway" },
  { id: "jobs", label: "Job runner" },
  { id: "storage", label: "Object storage" },
] as const;

export type ServiceId = (typeof serviceIds)[number];

export function isServiceId(value: string): value is ServiceId {
  return serviceIds.some((serviceId) => serviceId === value);
}
