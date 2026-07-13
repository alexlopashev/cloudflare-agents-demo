import { Deployboard } from "./deployboard/Deployboard";
import { resolveExperience } from "./experience";
import { InvestigatorWidget } from "./investigator/InvestigatorWidget";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/app">
        Regression Surgeon
      </a>
    </header>
  );
}

export function App() {
  const experience = resolveExperience(window.location.pathname);
  document.title = `${experience.title} · Regression Surgeon`;

  return (
    <div className="site-shell">
      <SiteHeader />
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
