import { describe, expect, it } from "vitest";

import {
  evidenceInvestigationRequested,
  evidenceInvestigationStartedByLatestMessage,
  messagesForCurrentInvestigation,
  remediationPreviewRequested,
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

  it("does not mistake an approval follow-up transcript for a new investigation", () => {
    const investigation = {
      role: "user",
      content: [{ type: "text", text: "Investigate the latency regression" }],
    };

    expect(evidenceInvestigationStartedByLatestMessage([investigation])).toBe(true);
    expect(
      evidenceInvestigationStartedByLatestMessage([
        investigation,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "create_draft_pr",
              toolCallId: "draft-1",
              input: { proposalFingerprint: "proposal-v1-0123456789abcdef" },
            },
          ],
        },
      ]),
    ).toBe(false);
    expect(
      evidenceInvestigationStartedByLatestMessage([
        investigation,
        { role: "assistant", content: [{ type: "text", text: "Completed." }] },
        {
          role: "user",
          content: [{ type: "text", text: "Investigate the regression again" }],
        },
      ]),
    ).toBe(true);
  });

  it("recognizes only the explicit guarded-preview request", () => {
    expect(
      remediationPreviewRequested([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Investigate the seeded latency regression and prepare the guarded remediation preview.",
            },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      remediationPreviewRequested([
        { role: "user", content: [{ type: "text", text: "Investigate the latency regression" }] },
      ]),
    ).toBe(false);
  });
});
