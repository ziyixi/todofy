import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="muted">{alt || "Image omitted"}</span>,
};

export default function DescriptionMarkdown({ children }: { children: string }) {
  return (
    <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
