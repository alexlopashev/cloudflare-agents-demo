export type Experience =
  | { kind: "deployboard"; title: "Deployboard" }
  | { kind: "investigator"; title: "Regression Investigator" }
  | { kind: "not-found"; title: "Not found" };

export function resolveExperience(pathname: string): Experience {
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return { kind: "deployboard", title: "Deployboard" };
  }
  if (pathname === "/investigator" || pathname.startsWith("/investigator/")) {
    return { kind: "investigator", title: "Regression Investigator" };
  }
  return { kind: "not-found", title: "Not found" };
}
