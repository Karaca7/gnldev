// Multimodal part rendering (S4): extracts safely displayable content from AI SDK message parts
// persisted in the journal — image parts become inline <img>, other file parts become a chip.
// Security: only data:image/* and http(s) sources; any other scheme (javascript: etc.) is not rendered.
import { FileText, ImageOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Produce a safe <img> src from a part; null if it can't be displayed. */
export function mediaSrc(p: any): string | null {
  // image part: {type:'image', image: string} · file part: {type:'file', data: string, mediaType}
  const raw = typeof p?.image === 'string' ? p.image : typeof p?.data === 'string' ? p.data : null;
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes(':') || raw.includes(',')) return null; // unknown scheme/data URL → reject
  // Bare base64 (allowed by the AI SDK): build a data URL from mediaType; assume png for image parts.
  const mt = typeof p?.mediaType === 'string' ? p.mediaType : typeof p?.mimeType === 'string' ? p.mimeType : '';
  if (mt.startsWith('image/')) return `data:${mt};base64,${raw}`;
  if (p?.type === 'image' && !mt) return `data:image/png;base64,${raw}`;
  return null;
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
          return src ? (
            <img key={i} src={src} alt={p.filename ?? `${t('media')} ${i + 1}`} className="max-h-40 max-w-full rounded-md border border-border object-contain" />
          ) : (
            <span key={i} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground" title={t('sourceUnavailableTitle')}>
              <ImageOff size={12} /> {t('unviewableMedia')}
            </span>
          );
        }
        // non-image file part: a mediaType chip; a download link if it's a data: URL.
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
