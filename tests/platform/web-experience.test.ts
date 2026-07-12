import { describe, expect, it } from "vitest";

import { resolveExperience } from "../../apps/web/src/experience";

describe("web experience routing", () => {
  it("maps the two public product paths to distinct experiences", () => {
    expect(resolveExperience("/app")).toEqual({
      kind: "deployboard",
      title: "Deployboard",
    });
    expect(resolveExperience("/investigator")).toEqual({
      kind: "investigator",
      title: "Regression Investigator",
    });
  });

  it("fails closed for paths outside the public shell", () => {
    expect(resolveExperience("/api/health")).toEqual({ kind: "not-found", title: "Not found" });
    expect(resolveExperience("/")).toEqual({ kind: "not-found", title: "Not found" });
  });
});
