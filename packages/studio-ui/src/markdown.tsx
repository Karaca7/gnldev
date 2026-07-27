// GFM markdown + syntax highlight: react-markdown (does NOT render HTML → XSS-safe) +
// remark-gfm (tables/strikethrough/task lists) + rehype-highlight (hljs classes).
// Visual language: Local Influence — code is JetBrains Mono, tables use the card surface, links use brand.
import { isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './components';
import './markdown.css';

/** Code block header + copy button; content is the <code> tagged by rehype-highlight. */
function Pre({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('common');
  // Bug-investigation fix #7: 'idle'/'done'/'error' — doesn't unconditionally show "success"
  // without waiting for the clipboard-write RESULT (inside .then()); failure becomes visible in .catch().
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  // <pre><code class="hljs language-ts">…</code></pre> — extract the language tag from the class.
  const codeEl = isValidElement(children) ? (children as any) : null;
  const cls: string = codeEl?.props?.className ?? '';
  const lang = /language-([\w-]+)/.exec(cls)?.[1] ?? '';
  const raw = extractText(codeEl?.props?.children);

  const copy = () => {
    const clip = navigator.clipboard;
    if (!clip) { setState('error'); setTimeout(() => setState('idle'), 1200); return; }
    clip.writeText(raw)
      .then(() => setState('done'))
      .catch(() => setState('error'))
      .finally(() => setTimeout(() => setState('idle'), 1200));
  };

  return (
    <div className="relative my-1.5 overflow-hidden rounded-md border border-border bg-foreground/[0.05]">
      <div className="flex items-center justify-between border-b border-border px-2 py-0.5">
        <span className="microlabel text-muted-foreground">{lang || t('code')}</span>
        <button
          type="button"
          onClick={copy}
          title={state === 'error' ? t('copyFailed') : t('copyCode')}
          className={cn('rounded-sm p-0.5 hover:text-brand', state === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {state === 'done' ? <Check size={12} /> : state === 'error' ? <X size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as any).children);
  return '';
}

/**
 * Chat/markdown body. HTML input is not rendered (react-markdown's default) — raw HTML in the
 * model's output stays as harmless text. Links open in a new tab, http(s)/mailto only.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body space-y-1.5 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <Pre>{children}</Pre>,
          code: ({ className, children, ...props }) =>
            className ? (
              <code className={className} {...props}>{children}</code> // inside a block — wrapped by Pre
            ) : (
              <code className="rounded-sm bg-foreground/10 px-1 font-mono text-[0.85em]">{children}</code>
            ),
          a: ({ href, children }) => {
            const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
            return safe
              ? <a href={safe} target="_blank" rel="noreferrer" className="text-brand underline underline-offset-2 hover:opacity-80">{children}</a>
              : <span>{children}</span>;
          },
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/40 text-muted-foreground">{children}</thead>,
          th: ({ children }) => <th className="border-b border-border px-2 py-1 font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-border/50 px-2 py-1 align-top">{children}</td>,
          ul: ({ children }) => <ul className="list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-0.5 pl-5">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-brand/50 pl-2 text-muted-foreground">{children}</blockquote>,
          h1: ({ children }) => <div className="text-sm font-bold">{children}</div>,
          h2: ({ children }) => <div className="text-sm font-semibold">{children}</div>,
          h3: ({ children }) => <div className="text-[13px] font-semibold">{children}</div>,
          hr: () => <hr className="border-border" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
