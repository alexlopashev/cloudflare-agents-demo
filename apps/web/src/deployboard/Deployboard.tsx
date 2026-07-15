import { useRef, useState } from "react";

import { serviceDefinitions, type HealthReport } from "../../../../packages/contracts/src/health";
import {
  metricSampleCounts,
  runDeployboardMetricBatch,
  runDeployboardRefresh,
  type MetricSampleCount,
} from "./client";

export type DeployboardViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: HealthReport }
  | { status: "error" };

export type MetricGenerationState =
  | { status: "idle" }
  | { status: "generating"; completed: number; total: MetricSampleCount }
  | { status: "ready"; completed: number; total: MetricSampleCount }
  | { status: "error"; completed: number; total: MetricSampleCount };

type DeployboardViewProps = {
  state: DeployboardViewState;
  metrics: MetricGenerationState;
  sampleCount: MetricSampleCount;
  onRefresh: () => void;
  onGenerateMetrics: () => void;
  onSampleCountChange: (sampleCount: MetricSampleCount) => void;
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

function metricStatus(metrics: MetricGenerationState) {
  if (metrics.status === "idle") {
    return <p>Each sample records one release-attributed UX event and distributed trace.</p>;
  }
  if (metrics.status === "error") {
    return (
      <p role="alert">
        Stopped after {metrics.completed} of {metrics.total} measured interactions. Existing samples
        remain available.
      </p>
    );
  }
  const label = `${metrics.completed} of ${metrics.total} measured interactions recorded`;
  return (
    <div aria-live="polite" className="metric-progress">
      <progress max={metrics.total} value={metrics.completed} />
      <p>{metrics.status === "ready" ? `${label}.` : label}</p>
    </div>
  );
}

export function DeployboardView({
  state,
  metrics,
  sampleCount,
  onRefresh,
  onGenerateMetrics,
  onSampleCountChange,
}: DeployboardViewProps) {
  const services = visibleServices(state);
  const isBusy = state.status === "loading" || metrics.status === "generating";
  const shouldAlert =
    state.status === "error" || (state.status === "ready" && state.report.outcome === "failed");
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
        <button className="refresh-button" disabled={isBusy} onClick={onRefresh} type="button">
          {state.status === "loading" ? "Refreshing…" : "Refresh services"}
        </button>
      </section>

      <section className="metrics-generator panel" aria-labelledby="metrics-generator-title">
        <div>
          <p className="eyebrow">Optional telemetry ingestion</p>
          <h2 id="metrics-generator-title">Generate metrics data</h2>
          <p>
            Run a bounded sequence of real service-grid interactions. Samples execute one at a time
            and count only after telemetry is stored. This does not select or modify the configured
            incident.
          </p>
        </div>
        <div className="metric-generator-actions">
          <label htmlFor="metric-sample-count">Batch size</label>
          <select
            disabled={isBusy}
            id="metric-sample-count"
            onChange={(event) =>
              onSampleCountChange(Number(event.currentTarget.value) as MetricSampleCount)
            }
            value={sampleCount}
          >
            {metricSampleCounts.map((count) => (
              <option key={count} value={count}>
                {count} samples
              </option>
            ))}
          </select>
          <button disabled={isBusy} onClick={onGenerateMetrics} type="button">
            {metrics.status === "generating" ? "Generating…" : "Generate metrics"}
          </button>
        </div>
        <div className="metric-generator-status">{metricStatus(metrics)}</div>
      </section>

      <section aria-busy={isBusy} aria-live="polite" className="health-results" role="status">
        <div className="results-heading">
          <div>
            <p className="eyebrow">Current interaction</p>
            <h2>Service health</h2>
          </div>
          {shouldAlert ? <p role="alert">{summary(state)}</p> : <p>{summary(state)}</p>}
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

export function Deployboard() {
  const [state, setState] = useState<DeployboardViewState>({ status: "idle" });
  const [metrics, setMetrics] = useState<MetricGenerationState>({ status: "idle" });
  const [sampleCount, setSampleCount] = useState<MetricSampleCount>(5);
  const inFlight = useRef(false);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ status: "loading" });
    try {
      const report = await runDeployboardRefresh({
        interactionId: crypto.randomUUID(),
        fetcher: (request) => fetch(request),
        emitCompletion: () => undefined,
      });
      setState({ status: "ready", report });
    } catch {
      setState({ status: "error" });
    } finally {
      inFlight.current = false;
    }
  }

  async function generateMetrics() {
    if (inFlight.current) return;
    inFlight.current = true;
    let completed = 0;
    setMetrics({ status: "generating", completed, total: sampleCount });
    try {
      const result = await runDeployboardMetricBatch({
        sampleCount,
        createInteractionId: () => `metric-${crypto.randomUUID()}`,
        fetcher: (request) => fetch(request),
        emitCompletion: () => undefined,
        onProgress: (progress) => {
          completed = progress.completed;
          setState({ status: "ready", report: progress.latestReport });
          setMetrics({
            status: "generating",
            completed: progress.completed,
            total: progress.total,
          });
        },
      });
      setState({ status: "ready", report: result.latestReport });
      setMetrics({ status: "ready", completed: result.sampleCount, total: result.sampleCount });
    } catch {
      setMetrics({ status: "error", completed, total: sampleCount });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <DeployboardView
      metrics={metrics}
      onGenerateMetrics={() => void generateMetrics()}
      onRefresh={() => void refresh()}
      onSampleCountChange={setSampleCount}
      sampleCount={sampleCount}
      state={state}
    />
  );
}
