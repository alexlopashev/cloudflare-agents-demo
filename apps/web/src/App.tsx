import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useState, type FormEvent } from "react";
import { useAgent } from "agents/react";

import { Deployboard } from "./deployboard/Deployboard";
import { resolveExperience } from "./experience";
import { buildToolTimeline, ToolTimeline } from "./investigator/ToolTimeline";

function messageText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function Investigator() {
  const [input, setInput] = useState("");
  const agent = useAgent({ agent: "RegressionSurgeonAgent", name: "local-investigation" });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const toolTimeline = buildToolTimeline(messages);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || status !== "ready") return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  }

  return (
    <main className="investigator-layout">
      <section className="panel investigation-context">
        <p className="eyebrow">Project Think session</p>
        <h1>Regression Investigator</h1>
        <p className="lede">
          Ask for an evidence-backed investigation. The session is durable and reconnects to the
          same local case without duplicating messages.
        </p>
        <dl>
          <div className="composer-fields">
            <dt>Mode</dt>
            <dd>Credential-free fake model</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>local-investigation</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{status}</dd>
          </div>
        </dl>
      </section>
      <section className="panel chat-panel" aria-label="Investigation chat">
        <ToolTimeline entries={toolTimeline} />
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <p className="empty-state">Describe a latency regression to begin.</p>
          ) : (
            messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span>{message.role === "user" ? "You" : "Investigator"}</span>
                <p>{messageText(message.parts)}</p>
              </article>
            ))
          )}
        </div>
        <form className="composer" onSubmit={submit}>
          <label htmlFor="investigation-prompt">Investigation request</label>
          <div>
            <input
              id="investigation-prompt"
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder="Why did interaction latency regress?"
              value={input}
            />
            <button disabled={status !== "ready" || input.trim().length === 0} type="submit">
              Investigate
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

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
          <a aria-current={experience.kind === "deployboard" ? "page" : undefined} href="/app">
            Deployboard
          </a>
          <a
            aria-current={experience.kind === "investigator" ? "page" : undefined}
            href="/investigator"
          >
            Investigator
          </a>
        </nav>
      </header>
      {experience.kind === "deployboard" && <Deployboard />}
      {experience.kind === "investigator" && <Investigator />}
      {experience.kind === "not-found" && (
        <main className="panel not-found">
          <h1>Not found</h1>
          <a href="/app">Open Deployboard</a>
        </main>
      )}
    </div>
  );
}
