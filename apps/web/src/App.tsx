import { Deployboard } from "./deployboard/Deployboard";
import { resolveExperience } from "./experience";
import { InvestigatorWidget } from "./investigator/InvestigatorWidget";

export function App() {
  const experience = resolveExperience(window.location.pathname);
  document.title = `${experience.title} · Regression Surgeon`;

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="/app">
          Regression Surgeon
        </a>
        <nav aria-label="Product experiences">
          <a
            aria-current={
              experience.kind === "product" && !experience.investigatorInitiallyOpen
                ? "page"
                : undefined
            }
            href="/app"
          >
            Deployboard
          </a>
          <a
            aria-current={
              experience.kind === "product" && experience.investigatorInitiallyOpen
                ? "page"
                : undefined
            }
            href="/investigator"
          >
            Investigator
          </a>
        </nav>
      </header>
      {experience.kind === "product" && (
        <>
          <Deployboard />
          <InvestigatorWidget initiallyOpen={experience.investigatorInitiallyOpen} />
        </>
      )}
      {experience.kind === "not-found" && (
        <main className="panel not-found">
          <h1>Not found</h1>
          <a href="/app">Open Deployboard</a>
        </main>
      )}
    </div>
  );
}
