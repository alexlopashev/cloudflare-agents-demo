import { useRef, useState } from "react";

import { serviceDefinitions, type HealthReport } from "../../../../packages/contracts/src/health";
import { runDeployboardRefresh, type DeployboardCompletion } from "./client";

export type DeployboardViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: HealthReport }
  | { status: "error" };

type DeployboardViewProps = {
  state: DeployboardViewState;
  onRefresh: () => void;
};

type VisibleService = {
  id: (typeof serviceDefinitions)[number]["id"];
  label: string;
  status: "not-checked" | "healthy" | "unavailable";
  message: string;
};

function visibleServices(state: DeployboardViewState): VisibleService[] {
  if (state.status === "ready") {
    return state.report.services.map((service) => ({
      id: service.id,
      label: service.label,
      status: service.status,
      message: service.status === "healthy" ? "Healthy" : service.error.message,
    }));
  }
  if (state.status === "error") {
    return serviceDefinitions.map((service) => ({
      ...service,
      status: "unavailable",
      message: "Unavailable",
    }));
  }
  return serviceDefinitions.map((service) => ({
    ...service,
    status: "not-checked",
    message: "Not checked",
  }));
}

function summary(state: DeployboardViewState): string {
  if (state.status === "idle") return "Ready to check three supervised services.";
  if (state.status === "loading") return "Refreshing services…";
  if (state.status === "error") return "Refresh failed. Service health remains unavailable.";
  const healthy = state.report.services.filter((service) => service.status === "healthy").length;
  return `${healthy} of ${state.report.services.length} services healthy`;
}

export function DeployboardView({ state, onRefresh }: DeployboardViewProps) {
  const services = visibleServices(state);
  return (
    <main className="deployboard-layout">
      <section className="hero panel deployboard-hero">
        <div>
          <p className="eyebrow">Supervised application</p>
          <h1>Deployboard</h1>
          <p className="lede">
            Refresh one full-stack interaction across three auxiliary service checks. Every result
            carries the release and trace evidence needed for investigation.
          </p>
        </div>
        <button
          className="refresh-button"
          disabled={state.status === "loading"}
          onClick={onRefresh}
          type="button"
        >
          {state.status === "loading" ? "Refreshing…" : "Refresh services"}
        </button>
      </section>

      <section
        aria-busy={state.status === "loading"}
        aria-live="polite"
        className="health-results"
        role="status"
      >
        <div className="results-heading">
          <div>
            <p className="eyebrow">Current interaction</p>
            <h2>Service health</h2>
          </div>
          {state.status === "error" ? (
            <p role="alert">{summary(state)}</p>
          ) : (
            <p>{summary(state)}</p>
          )}
        </div>
        <ul className="service-grid">
          {services.map((service) => (
            <li className={`panel service-card ${service.status}`} key={service.id}>
              <span className="service-icon" aria-hidden="true" />
              <div>
                <h3>{service.label}</h3>
                <p>{service.message}</p>
              </div>
            </li>
          ))}
        </ul>
        {state.status === "ready" && (
          <dl className="evidence-strip">
            <div>
              <dt>Interaction</dt>
              <dd>{state.report.interactionId}</dd>
            </div>
            <div>
              <dt>Trace</dt>
              <dd>{state.report.traceId}</dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>{state.report.releaseId}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}

function emitCompletion(completion: DeployboardCompletion) {
  window.dispatchEvent(
    new CustomEvent<DeployboardCompletion>("deployboard:interaction-complete", {
      detail: completion,
    }),
  );
}

export function Deployboard() {
  const [state, setState] = useState<DeployboardViewState>({ status: "idle" });
  const inFlight = useRef(false);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ status: "loading" });
    try {
      const report = await runDeployboardRefresh({
        interactionId: crypto.randomUUID(),
        fetcher: (request) => fetch(request),
        emitCompletion,
      });
      setState({ status: "ready", report });
    } catch {
      setState({ status: "error" });
    } finally {
      inFlight.current = false;
    }
  }

  return <DeployboardView onRefresh={() => void refresh()} state={state} />;
}
