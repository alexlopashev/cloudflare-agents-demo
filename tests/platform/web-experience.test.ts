import { describe, expect, it } from "vitest";

import { resolveExperience } from "../../apps/web/src/experience";

describe("web experience routing", () => {
  it("maps both public paths to Deployboard and deep-links the investigator open state", () => {
    expect(resolveExperience("/app")).toEqual({
      kind: "product",
      title: "Deployboard",
      investigatorInitiallyOpen: false,
    });
    expect(resolveExperience("/investigator")).toEqual({
      kind: "product",
      title: "Regression Investigator",
      investigatorInitiallyOpen: true,
    });
  });

  it("fails closed for paths outside the public shell", () => {
    expect(resolveExperience("/api/health")).toEqual({ kind: "not-found", title: "Not found" });
    expect(resolveExperience("/")).toEqual({ kind: "not-found", title: "Not found" });
  });
});
