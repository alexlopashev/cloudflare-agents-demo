import { useAgentChat } from "@cloudflare/ai-chat/react";
import { lazy, Suspense, useState, type FormEvent } from "react";
import { useAgent } from "agents/react";

import { Deployboard } from "./deployboard/Deployboard";
import { resolveExperience } from "./experience";
import { ApprovalPanel, buildApprovalRequests } from "./investigator/ApprovalPanel";
import { messageText } from "./investigator/messages";
import { resolveInvestigatorSession } from "./investigator/session";
import { buildToolTimeline, ToolTimeline } from "./investigator/ToolTimeline";

const InvestigatorMessage = lazy(() => import("./investigator/InvestigatorMessage"));

function Investigator() {
  const [input, setInput] = useState("");
  const [session] = useState(() => resolveInvestigatorSession(window.localStorage));
  const agent = useAgent({ agent: "RegressionSurgeonAgent", name: session });
  const { addToolApprovalResponse, messages, sendMessage, status } = useAgentChat({ agent });
  const toolTimeline = buildToolTimeline(messages);
  const approvals = buildApprovalRequests(messages);
  const visibleMessages = messages
    .map((message) => ({ message, text: messageText(message.parts) }))
    .filter(({ text }) => text.length > 0);

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
          same browser-local case without duplicating messages. No account or login is required.
        </p>
        <dl>
          <div className="composer-fields">
            <dt>Mode</dt>
            <dd>Project Think investigator</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{session}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{status}</dd>
          </div>
        </dl>
      </section>
      <section className="panel chat-panel" aria-label="Investigation chat">
        <ToolTimeline entries={toolTimeline} />
        <ApprovalPanel
          requests={approvals}
          onDecision={(id, approved) => addToolApprovalResponse({ id, approved })}
        />
        <div className="messages" aria-live="polite">
          {visibleMessages.length === 0 ? (
            <p className="empty-state">Describe a latency regression to begin.</p>
          ) : (
            visibleMessages.map(({ message, text }) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span>{message.role === "user" ? "You" : "Investigator"}</span>
                <Suspense fallback={<p className="message-content plain-message">{text}</p>}>
                  <InvestigatorMessage messageRole={message.role} text={text} />
                </Suspense>
              </article>
            ))
          )}
        </div>
        <form className="composer" onSubmit={submit}>
          <label htmlFor="investigation-prompt">Investigation request</label>
          <div className="composer-controls">
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
