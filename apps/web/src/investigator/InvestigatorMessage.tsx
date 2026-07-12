import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface InvestigatorMessageProps {
  readonly messageRole: string;
  readonly text: string;
}

export function InvestigatorMessage({ messageRole, text }: InvestigatorMessageProps) {
  if (messageRole !== "assistant") {
    return <p className="message-content plain-message">{text}</p>;
  }

  return (
    <div className="message-content markdown-content">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

export default InvestigatorMessage;
