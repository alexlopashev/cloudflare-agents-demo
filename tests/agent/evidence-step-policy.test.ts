import { describe, expect, it } from "vitest";

import {
  evidenceInvestigationRequested,
  messagesForCurrentInvestigation,
} from "../../workers/platform/src/agent/evidence-step-policy";

describe("Project Think investigation intent", () => {
  it("recognizes an investigation request without treating ordinary chat as evidence work", () => {
    expect(
      evidenceInvestigationRequested([
        { role: "user", content: [{ type: "text", text: "Investigate the latency regression" }] },
      ]),
    ).toBe(true);
    expect(
      evidenceInvestigationRequested([
        { role: "user", content: [{ type: "text", text: "Thanks for the report" }] },
      ]),
    ).toBe(false);
  });

  it("starts a new investigation after the latest matching user request", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Investigate the latency regression" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier conclusion" }] },
      { role: "user", content: [{ type: "text", text: "Investigate the regression again" }] },
      { role: "assistant", content: [{ type: "text", text: "Current investigation" }] },
    ];

    expect(messagesForCurrentInvestigation(messages)).toEqual(messages.slice(2));
  });
});
