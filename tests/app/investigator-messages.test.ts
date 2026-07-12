import { describe, expect, it } from "vitest";

import { messageText } from "../../apps/web/src/investigator/messages";

describe("investigator visible messages", () => {
  it("omits tool-only turns while preserving completed text", () => {
    expect(messageText([{ type: "step-start" }, { type: "tool-create_draft_pr" }])).toBe("");
    expect(messageText([{ type: "step-start" }, { type: "text", text: "Validated preview" }])).toBe(
      "Validated preview",
    );
  });
});
