// Multimodal part rendering (S4): extracts safely displayable content from AI SDK message parts
// Persisted in the journal — image parts become inline <img>, other file parts become a chip.
// Security: only data:image/* and http(s) sources; any other scheme (javascript: etc.) is not rendered.
import { FileText, ImageOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Produce a safe <img> src from a part; null if it can't be displayed inline.
 *
 * `http(s)` is deliberately NOT inlined. Journal content is not all the operator's own: a tool result
 * Or a model turn can name any address, and rendering it sends a request the operator never made,
 * Carrying whatever the author encoded in the URL plus the operator's IP and the time they opened the
 * Run. `remoteMediaHref` gives the same part back as something they can open ON PURPOSE — a click is
 * A decision, an automatic fetch is not. Same reasoning as the `img` handler in markdown.tsx.
 */
export function mediaSrc(p: any): string | null {
  // Image part: {type:'image', image: string} · file part: {type:'file', data: string, mediaType}
  const raw = typeof p?.image === 'string' ? p.image : typeof p?.data === 'string' ? p.data : null;
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return null; // displayable, but only after the operator asks
  if (raw.includes(':') || raw.includes(',')) return null; // unknown scheme/data URL → reject
  // Bare base64 (allowed by the AI SDK): build a data URL from mediaType; assume png for image parts.
  // The media type is interpolated into the URL, so it is matched rather than merely prefix-checked —
  // It comes from the journal, and `image/png;base64,…` would otherwise be pasted in whole.
  const mt = typeof p?.mediaType === 'string' ? p.mediaType : typeof p?.mimeType === 'string' ? p.mimeType : '';
  if (/^image\/[a-z0-9.+-]+$/i.test(mt)) return `data:${mt};base64,${raw}`;
  if (p?.type === 'image' && !mt) return `data:image/png;base64,${raw}`;
  return null;
}

/** A remote source the operator may open deliberately — never fetched by rendering. */
export function remoteMediaHref(p: any): string | null {
  const raw = typeof p?.image === 'string' ? p.image : typeof p?.data === 'string' ? p.data : null;
  return typeof raw === 'string' && /^https?:\/\//i.test(raw) ? raw : null;
}

const isImagePart = (p: any) =>
  p?.type === 'image' || (p?.type === 'file' && typeof p?.mediaType === 'string' && p.mediaType.startsWith('image/'));

/**
 * Renders media parts from a message's content array (text parts are the caller's responsibility).
 * Renders nothing if there's no media — MessageCard can use it unconditionally.
 */
export function MediaParts({ content }: { content: unknown }) {
  const { t } = useTranslation('common');
  if (!Array.isArray(content)) return null;
  const media = content.filter((p: any) => isImagePart(p) || p?.type === 'file');
  if (media.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2" data-media-parts>
      {media.map((p: any, i: number) => {
        if (isImagePart(p)) {
          const src = mediaSrc(p);
          if (src) {
            return <img key={i} src={src} alt={p.filename ?? `${t('media')} ${i + 1}`} className="max-h-40 max-w-full rounded-md border border-border object-contain" />;
          }
          // A remote image: shown as its address rather than fetched. The operator can still open it,
          // Which is the point — the request should be theirs, not the page's.
          const href = remoteMediaHref(p);
          return href ? (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-brand underline underline-offset-2 hover:opacity-80"
              title={href}
            >
              <ImageOff size={12} /> <span className="truncate">{p.filename ?? href}</span>
            </a>
          ) : (
            <span key={i} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground" title={t('sourceUnavailableTitle')}>
              <ImageOff size={12} /> {t('unviewableMedia')}
            </span>
          );
        }
        // Non-image file part: a mediaType chip; a download link if it's a data: URL.
        const data = typeof p?.data === 'string' && p.data.startsWith('data:') ? p.data : null;
        const label = p.filename ?? p.mediaType ?? t('file');
        return (
          <span key={i} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <FileText size={12} />
            {data ? (
              <a href={data} download={p.filename ?? t('file')} className="text-brand underline underline-offset-2 hover:opacity-80">{label}</a>
            ) : (
              label
            )}
          </span>
        );
      })}
    </div>
  );
}
