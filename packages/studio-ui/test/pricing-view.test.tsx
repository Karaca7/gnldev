// @vitest-environment jsdom
// Scope: the Pricing view shows the EFFECTIVE table (journal overrides layered over the prices shipped
// with @gnldev/durable), and its cost preview resolves a model id the same way `priceFor` does.
//
// Both are about the same failure. An unpriced model counts as $0 and a $0 step cannot exceed any
// maxCostUsd, so a ceiling stops capping without failing — which means a screen that shows only the
// operator's own rows would hide the prices most runs are billed at, and a preview that resolved ids
// differently from the runtime would confirm a number the runtime never uses.
//
// The prefix case is the one that already went wrong once: one `claude-opus-4` row answered every
// `claude-opus-4*` id, so Opus 4 was billed at Opus 4.5's rate — a third of the real one — and nothing
// distinguished that from a correct answer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Pricing } from '../src/views/Pricing';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function jsonOk(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const RESPONSE = {
  version: 3,
  editable: true,
  overrides: { 'acme/new-model': { inputPer1M: 10, outputPer1M: 30 } },
  effective: {
    'acme/new-model': { inputPer1M: 10, outputPer1M: 30 },
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
    'claude-opus-4-5': { inputPer1M: 5, outputPer1M: 25 },
  },
};

const serve = (body: unknown = RESPONSE) =>
  vi.stubGlobal('fetch', vi.fn(async () => jsonOk(body)));

describe('Pricing view', () => {
  it('lists the EFFECTIVE table, not just the operator\'s overrides', async () => {
    serve();
    wrap(<Pricing />);
    // The override…
    await waitFor(() => expect(screen.getByText('acme/new-model')).toBeTruthy());
    // …and a model that comes from the shipped defaults, which is what most runs are billed at.
    expect(screen.getByText('gpt-4o'), 'a default-priced model is missing from the table').toBeTruthy();
  });

  it('marks which rows are the operator\'s own', async () => {
    serve();
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByText('acme/new-model')).toBeTruthy());
    // Editable inputs exist only for owned rows; a default row is read-only text.
    expect(screen.getByLabelText('acme/new-model inputPer1M')).toBeTruthy();
    expect(screen.queryByLabelText('gpt-4o inputPer1M')).toBeNull();
  });

  it('the cost preview resolves a dated id through its PREFIX entry and says so', async () => {
    serve();
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByLabelText('model id')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('model id'), { target: { value: 'claude-opus-4-5-20251101' } });
    // Scoped to the preview line: the id also appears as a TABLE ROW, so a bare getByText matches two
    // elements and would pass on the row alone — i.e. without the preview resolving anything at all.
    const line = await waitFor(() => screen.getByText(/matched entry:/));
    expect(line.textContent).toContain('claude-opus-4-5');
    // Naming it a prefix match is the whole point: otherwise a family sharing one price reads as exact.
    expect(line.textContent).toContain('prefix match');
    // 1M in @ $5 + 1M out @ $25
    expect(screen.getByText('$30')).toBeTruthy();
  });

  it('says plainly when a model has no price, instead of showing $0', async () => {
    serve();
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByLabelText('model id')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('model id'), { target: { value: 'nobody/prices-this' } });
    await waitFor(() => expect(screen.getByText(/No price for this model/)).toBeTruthy());
    expect(screen.getByText(/cannot cap it at any threshold/)).toBeTruthy();
  });

  it('the preview reflects an UNSAVED edit — otherwise it confirms the old number', async () => {
    serve();
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByLabelText('acme/new-model inputPer1M')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('acme/new-model inputPer1M'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('model id'), { target: { value: 'acme/new-model' } });
    // 1M in @ $100 + 1M out @ $30
    await waitFor(() => expect(screen.getByText('$130')).toBeTruthy());
  });

  it('accepts a decimal price typed CHARACTER BY CHARACTER', async () => {
    // The bug this pins: the draft stored numbers, so every keystroke ran Number(raw). Typing "99.5"
    // went "9" → "99" → Number("99.") = 99 → rendered "99" → "995". A price ten times too large, in
    // the field a spend ceiling reads, silently.
    //
    // Typing one character at a time is the whole point. The other tests here set the value in ONE
    // change event, which is why seven green tests missed this and opening the page in a browser
    // found it immediately.
    serve();
    wrap(<Pricing />);
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);

    fireEvent.change(field, { target: { value: '' } }); // start from empty, as a user selecting-all would
    for (const ch of '99.5') {
      fireEvent.change(field, { target: { value: field.value + ch } });
    }
    expect(field.value, 'the decimal point was eaten while typing').toBe('99.5');

    // ...and the preview prices with the typed value, not a mangled one.
    fireEvent.change(screen.getByLabelText('model id'), { target: { value: 'acme/new-model' } });
    // 1M in @ $99.5 + 1M out @ $30
    await waitFor(() => expect(screen.getByText('$129.50')).toBeTruthy());
  });

  it('lets a field be cleared without rewriting it under the cursor', async () => {
    serve();
    wrap(<Pricing />);
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);
    fireEvent.change(field, { target: { value: '' } });
    expect(field.value).toBe('');
  });

  it('warns when replace is on, because everything else silently costs $0', async () => {
    serve({ ...RESPONSE, replace: true });
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByText(/replace is on/)).toBeTruthy());
  });

  it('a read-only journal shows the table but offers no editing', async () => {
    serve({ version: 0, editable: false, overrides: {}, effective: RESPONSE.effective });
    wrap(<Pricing />);
    await waitFor(() => expect(screen.getByText(/read-only/)).toBeTruthy());
    expect(screen.queryByLabelText('new model id')).toBeNull();
  });
});
