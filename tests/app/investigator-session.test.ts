import { describe, expect, it } from "vitest";

import {
  clearInvestigatorSession,
  resolveInvestigatorSession,
} from "../../apps/web/src/investigator/session.ts";

describe("public investigator session", () => {
  it("reuses one valid browser-local durable session", () => {
    const storage = new Map([["regression-surgeon-session", "browser-abc123"]]);
    const setItem = (key: string, value: string) => storage.set(key, value);

    expect(
      resolveInvestigatorSession(
        { getItem: (key) => storage.get(key) ?? null, setItem },
        () => "unused",
      ),
    ).toBe("browser-abc123");
  });

  it("creates and persists an isolated session without login", () => {
    const storage = new Map<string, string>();
    const session = resolveInvestigatorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      () => "5b1e9d57-4259-482f-98dc-28e42bf72456",
    );

    expect(session).toBe("browser-5b1e9d57-4259-482f-98dc-28e42bf72456");
    expect(storage.get("regression-surgeon-session")).toBe(session);
  });

  it("replaces malformed shared state", () => {
    const storage = new Map([["regression-surgeon-session", "local-investigation"]]);
    const session = resolveInvestigatorSession(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      () => "new-session",
    );

    expect(session).toBe("browser-new-session");
  });

  it("clears only the persisted investigator session", () => {
    const storage = new Map([
      ["regression-surgeon-session", "browser-abc123"],
      ["unrelated-preference", "preserved"],
    ]);

    clearInvestigatorSession({ removeItem: (key) => storage.delete(key) });

    expect(storage.get("regression-surgeon-session")).toBeUndefined();
    expect(storage.get("unrelated-preference")).toBe("preserved");
  });
});
