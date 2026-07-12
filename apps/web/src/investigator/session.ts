export type SessionStorage = Pick<Storage, "getItem" | "setItem">;

const storageKey = "regression-surgeon-session";
const sessionPattern = /^browser-[A-Za-z0-9-]{6,80}$/;

export function resolveInvestigatorSession(
  storage: SessionStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const stored = storage.getItem(storageKey);
  if (stored !== null && sessionPattern.test(stored)) return stored;
  const session = `browser-${createId()}`;
  if (!sessionPattern.test(session)) throw new Error("Unable to create an investigator session.");
  storage.setItem(storageKey, session);
  return session;
}
