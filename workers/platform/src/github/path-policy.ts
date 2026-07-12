export function isSafeRepositoryPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.includes("\0")
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
