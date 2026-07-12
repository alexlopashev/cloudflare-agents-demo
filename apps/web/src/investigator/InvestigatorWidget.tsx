import { useAgentChat } from "@cloudflare/ai-chat/react";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAgent } from "agents/react";

import { ApprovalPanel, buildApprovalRequests } from "./ApprovalPanel";
import { messageText } from "./messages";
import { resolveInvestigatorSession } from "./session";
import { buildToolTimeline, ToolTimeline } from "./ToolTimeline";

const InvestigatorMessage = lazy(() => import("./InvestigatorMessage"));

type InvestigatorWidgetChromeProps = {
  isOpen: boolean;
  unreadCount: number;
  status: string;
  onToggle: () => void;
  children: ReactNode;
};

function widgetStatus(status: string): string {
  if (status === "ready") return "Available";
  if (status === "error") return "Needs attention";
  return "Investigating";
}

export function InvestigatorWidgetChrome({
  isOpen,
  unreadCount,
  status,
  onToggle,
  children,
}: InvestigatorWidgetChromeProps) {
  const boundedUnreadCount = Math.max(0, Math.floor(unreadCount));
  const unreadLabel = `${boundedUnreadCount} unread investigator update${boundedUnreadCount === 1 ? "" : "s"}`;
  return (
    <aside className={`support-widget${isOpen ? " open" : ""}`}>
      <section
        aria-labelledby="investigator-title"
        aria-modal="false"
        className="support-dialog panel"
        hidden={!isOpen}
        id="investigator-dialog"
        role="dialog"
      >
        <header className="support-dialog-header">
          <div>
            <p className="eyebrow">Project Think support</p>
            <h2 id="investigator-title">Regression Investigator</h2>
            <p className="support-status">
              <span aria-hidden="true" />
              {widgetStatus(status)}
            </p>
          </div>
          <button aria-label="Collapse investigator" onClick={onToggle} type="button">
            <span aria-hidden="true">−</span>
          </button>
        </header>
        {children}
      </section>
      <button
        aria-controls="investigator-dialog"
        aria-expanded={isOpen}
        aria-label={isOpen ? "Collapse regression investigator" : "Open regression investigator"}
        className="support-launcher"
        onClick={onToggle}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M5 4.5h14a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-7l-4.8 3.2.8-3.2H5A2.5 2.5 0 0 1 2.5 15V7A2.5 2.5 0 0 1 5 4.5Z" />
          <path d="M7.5 9h9M7.5 13h6" />
        </svg>
        <span
          aria-label={status === "ready" ? "Investigator available" : "Investigator active"}
          className="availability-badge"
          role="status"
        />
        {boundedUnreadCount > 0 && (
          <span aria-label={unreadLabel} className="notification-badge" role="status">
            {boundedUnreadCount > 9 ? "9+" : boundedUnreadCount}
          </span>
        )}
      </button>
    </aside>
  );
}

export function InvestigatorWidget({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [input, setInput] = useState("");
  const [unreadCount, setUnreadCount] = useState(initiallyOpen ? 0 : 1);
  const [session] = useState(() => resolveInvestigatorSession(window.localStorage));
  const agent = useAgent({ agent: "RegressionSurgeonAgent", name: session });
  const { addToolApprovalResponse, messages, sendMessage, status } = useAgentChat({ agent });
  const toolTimeline = buildToolTimeline(messages);
  const approvals = buildApprovalRequests(messages);
  const visibleMessages = messages
    .map((message) => ({ message, text: messageText(message.parts) }))
    .filter(({ text }) => text.length > 0);
  const assistantMessageCount = visibleMessages.filter(
    ({ message }) => message.role === "assistant",
  ).length;
  const previousAssistantMessageCount = useRef(assistantMessageCount);

  useEffect(() => {
    const added = Math.max(0, assistantMessageCount - previousAssistantMessageCount.current);
    previousAssistantMessageCount.current = assistantMessageCount;
    if (isOpen) setUnreadCount(0);
    else if (added > 0) setUnreadCount((count) => count + added);
  }, [assistantMessageCount, isOpen]);

  function toggle() {
    setIsOpen((open) => {
      const next = !open;
      if (next) setUnreadCount(0);
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || status !== "ready") return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  }

  return (
    <InvestigatorWidgetChrome
      isOpen={isOpen}
      onToggle={toggle}
      status={status}
      unreadCount={unreadCount}
    >
      <div className="chat-panel">
        <ToolTimeline entries={toolTimeline} />
        <ApprovalPanel
          requests={approvals}
          onDecision={(id, approved) => addToolApprovalResponse({ id, approved })}
        />
        <div className="messages" aria-live="polite">
          {visibleMessages.length === 0 ? (
            <div className="empty-state">
              <strong>How can I help?</strong>
              <p>Ask me to investigate the measured dashboard latency regression.</p>
            </div>
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
              Send
            </button>
          </div>
        </form>
      </div>
    </InvestigatorWidgetChrome>
  );
}
