// @vitest-environment jsdom
// Multimodal part rendering (S4): safe src derivation + the MediaParts view.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { mediaSrc, MediaParts, remoteMediaHref } from '../src/media';
import '../src/i18n'; // EN default language so MediaParts' t() calls use the real translation (same pattern as views.test.tsx).

afterEach(cleanup);

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg'; // content doesn't matter, format is representative

describe('mediaSrc', () => {
  it('a data:image source passes through unchanged — its bytes are already here', () => {
    expect(mediaSrc({ type: 'image', image: 'data:image/png;base64,AAA' })).toBe('data:image/png;base64,AAA');
  });

  // This used to return the URL, which made rendering a run send a request to it. Journal content is
  // not all the operator's own — a tool result or a model turn can name any address — so the page
  // would fetch on an attacker's behalf, carrying whatever was encoded in the URL plus the operator's
  // IP and the moment they opened the run. The part is still reachable, just not automatically.
  it('an http(s) source is NOT inlined; it is offered as a link instead', () => {
    expect(mediaSrc({ type: 'image', image: 'https://example.dev/a.png' })).toBeNull();
    expect(remoteMediaHref({ type: 'image', image: 'https://example.dev/a.png' })).toBe('https://example.dev/a.png');
    // Only http(s) — an unknown scheme is not a link either.
    expect(remoteMediaHref({ type: 'image', image: 'javascript:alert(1)' })).toBeNull();
  });

  // The media type is interpolated into a data: URL, so it is matched, not merely prefix-checked.
  it('a media type carrying its own payload is refused', () => {
    expect(mediaSrc({ type: 'file', data: PNG_B64, mediaType: 'image/png;base64,INJECTED' })).toBeNull();
    expect(mediaSrc({ type: 'file', data: PNG_B64, mediaType: 'image/svg+xml' })).toBe(`data:image/svg+xml;base64,${PNG_B64}`);
  });

  it('bare base64 becomes a data URL with mediaType; an image part with no mediaType defaults to png', () => {
    expect(mediaSrc({ type: 'file', data: PNG_B64, mediaType: 'image/jpeg' })).toBe(`data:image/jpeg;base64,${PNG_B64}`);
    expect(mediaSrc({ type: 'image', image: PNG_B64 })).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('unsafe/unknown schemes are rejected', () => {
    expect(mediaSrc({ type: 'image', image: 'javascript:alert(1)' })).toBeNull();
    expect(mediaSrc({ type: 'image', image: 'data:text/html,<script>' })).toBeNull();
    expect(mediaSrc({ type: 'image', image: 42 })).toBeNull();
  });
});

describe('MediaParts', () => {
  it('an image part renders as an inline <img>', () => {
    const { container } = render(
      <MediaParts content={[{ type: 'text', text: 'look' }, { type: 'image', image: 'data:image/png;base64,AAA' }]} />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAA');
  });

  it('an unviewable image part falls back to a safe chip (no img)', () => {
    const { container } = render(<MediaParts content={[{ type: 'image', image: 'javascript:alert(1)' }]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('unviewable media')).toBeTruthy();
  });

  it('a non-image file part becomes a chip + a download link if it is a data: URL', () => {
    const { container } = render(
      <MediaParts content={[{ type: 'file', data: 'data:application/pdf;base64,AAA', mediaType: 'application/pdf', filename: 'report.pdf' }]} />,
    );
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('data:application/pdf;base64,AAA');
    expect(a?.getAttribute('download')).toBe('report.pdf');
    expect(screen.getByText('report.pdf')).toBeTruthy();
  });

  // The channel this closes: rendering a run must not fetch an address the run's own content chose.
  it('a remote image part renders as a link, and fires no request', () => {
    const { container } = render(<MediaParts content={[{ type: 'image', image: 'https://evil.example/b.png?leak=DATA' }]} />);
    expect(container.querySelector('img'), 'an <img> here IS the request').toBeNull();
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://evil.example/b.png?leak=DATA');
    expect(a?.getAttribute('rel')).toContain('noreferrer');
  });

  it('renders nothing when there is no media part (text-only / string content)', () => {
    expect(render(<MediaParts content={[{ type: 'text', text: 'plain' }]} />).container.firstChild).toBeNull();
    expect(render(<MediaParts content={'plain string'} />).container.firstChild).toBeNull();
  });
});
