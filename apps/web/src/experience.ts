export type Experience =
  | {
      kind: "product";
      title: "Deployboard" | "Regression Investigator";
      investigatorInitiallyOpen: boolean;
    }
  | { kind: "not-found"; title: "Not found" };

export function resolveExperience(pathname: string): Experience {
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return { kind: "product", title: "Deployboard", investigatorInitiallyOpen: false };
  }
  if (pathname === "/investigator" || pathname.startsWith("/investigator/")) {
    return {
      kind: "product",
      title: "Regression Investigator",
      investigatorInitiallyOpen: true,
    };
  }
  return { kind: "not-found", title: "Not found" };
}
