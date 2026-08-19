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
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
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
  const r = render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
  return Object.assign(r, { qc });
}

const RESPONSE = {
  version: 3,
  editable: true,
  overrides: { 'acme/new-model': { inputPer1M: 10, outputPer1M: 30 } },
  // The SHIPPED table, served alongside `effective` so the editor can show what a row falls back to
  // when its override is removed. `effective` already contains the overrides, so it cannot answer that.
  defaults: {
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
    'claude-opus-4-5': { inputPer1M: 5, outputPer1M: 25 },
  },
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

  it('saves against the version the DRAFT was built on, not whatever refetched underneath it', async () => {
    // The silent overwrite this prevents. react-query refetches in the background (window focus, an
    // invalidate elsewhere), so reading the version at save time meant: another admin saves, our cache
    // quietly refreshes to their version, and our stale draft then PASSES the optimistic lock and
    // replaces their rows. The lock reported success in exactly the case it exists to catch.
    let version = 3;
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { bodies.push(String(init.body)); return jsonOk({ ok: true, version: version + 1 }); }
      return jsonOk({ ...RESPONSE, version });
    }));

    const { qc } = wrap(<Pricing />);
    const fetchCalls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.change(field, { target: { value: '77' } });

    // Another admin saves, and our cache ACTUALLY refetches — an invalidate is what react-query does on
    // window focus or after any other mutation. Merely changing the number the server would return is not
    // enough: the first version of this test did that, the cache never refreshed, and both the fixed and
    // the broken code sent the same value. The mutation check caught it.
    version = 9;
    await act(async () => { await qc.invalidateQueries({ queryKey: ['pricing'] }); });
    await waitFor(() => expect(fetchCalls()).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(bodies.length).toBe(1));
    const sent = JSON.parse(bodies[0]);
    expect(sent.ifVersion, 'the save used a version the draft never saw, so the conflict went undetected').toBe(3);
  });

  it('a fresh draft after a reload uses the NEW version — the pin is per draft, not forever', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { bodies.push(String(init.body)); return jsonOk({ ok: true, version: 12 }); }
      return jsonOk({ ...RESPONSE, version: 11 });
    }));

    wrap(<Pricing />);
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(bodies.length).toBe(1));
    expect(JSON.parse(bodies[0]).ifVersion).toBe(11);
  });

  it('refuses to save a CLEARED price instead of storing $0', async () => {
    // `Number('')` is 0, so an emptied field used to save as free — a blank box on screen, a $0 model on
    // the server, and a model that costs nothing cannot exceed any ceiling. The blank has to be refused,
    // not interpreted.
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { bodies.push(String(init.body)); return jsonOk({ ok: true, version: 4 }); }
      return jsonOk(RESPONSE);
    }));

    wrap(<Pricing />);
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    // Nothing is sent at all — the refusal happens before the request, which is the assertion. (The
    // toast itself renders through a portal this harness does not mount, so its text is not the proof.)
    await new Promise((r) => setTimeout(r, 300));
    expect(bodies, 'a cleared field was saved as $0').toEqual([]);
  });

  it('an emptied CACHE field is "not set", not zero — the one field that is optional', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { bodies.push(String(init.body)); return jsonOk({ ok: true, version: 4 }); }
      return jsonOk(RESPONSE);
    }));

    // The row must START with a cache price, or "clearing" it writes '' over '' — React fires no change
    // event, no draft is created, and Save stays disabled. The first version of this test did that and
    // measured the disabled button rather than the parsing rule.
    serve({ ...RESPONSE, overrides: { 'acme/new-model': { inputPer1M: 10, outputPer1M: 30, cachedInputPer1M: 2 } } });
    const bodies2: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { bodies2.push(String(init.body)); return jsonOk({ ok: true, version: 4 }); }
      return jsonOk({ ...RESPONSE, overrides: { 'acme/new-model': { inputPer1M: 10, outputPer1M: 30, cachedInputPer1M: 2 } } });
    }));

    wrap(<Pricing />);
    const cache = await waitFor(() => screen.getByLabelText('acme/new-model cachedInputPer1M') as HTMLInputElement);
    expect(cache.value, 'the fixture must start with a cache price for this test to mean anything').toBe('2');
    fireEvent.change(cache, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(bodies2.length).toBe(1));
    const sent = JSON.parse(bodies2[0]);
    expect(sent.models['acme/new-model']).not.toHaveProperty('cachedInputPer1M');
    expect(sent.models['acme/new-model'].inputPer1M, 'the other fields must survive').toBe(10);
  });

  it('a 409 is recoverable: the edits survive and the SECOND save goes through', async () => {
    // The draft stayed pinned to the version it was built on, so every later Save sent the same stale
    // ifVersion and got the same 409 — for good, with no discard button to escape through. Auto-retrying
    // would have been worse: that is the silent overwrite the lock exists to prevent. So the conflict is
    // resolved (edits kept, table refreshed) and the next Save is a deliberate act on top of what is now
    // there.
    let version = 3;
    let firstSave = true;
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        bodies.push(String(init.body));
        if (firstSave) {
          firstSave = false;
          version = 9; // another admin landed
          // A REAL Response: the api layer reads the error body via `res.clone().json()`, and a hand-rolled
          // object without `clone()` makes that throw into a catch that silently drops the body — so the
          // conflict's `current` version never reaches the view. The first version of this test did that
          // and measured a fix that could not have worked.
          return new Response(
            JSON.stringify({ error: 'conflict', code: 'version_conflict', current: { version: 9 } }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return jsonOk({ ok: true, version: 10 });
      }
      return jsonOk({ ...RESPONSE, version });
    }));

    wrap(<Pricing />);
    const field = await waitFor(() => screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.change(field, { target: { value: '77' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(JSON.parse(bodies[0]).ifVersion, 'the first save used the version the draft was built on').toBe(3);

    // The edit is still on screen — a conflict must not throw away what was typed.
    await waitFor(() => expect((screen.getByLabelText('acme/new-model inputPer1M') as HTMLInputElement).value).toBe('77'));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(bodies.length).toBe(2));
    const second = JSON.parse(bodies[1]);
    expect(second.ifVersion, 'the second save repeated the stale version and would 409 forever').toBe(9);
    expect(second.models['acme/new-model'].inputPer1M, 'the edit was lost on the way').toBe(77);
  });
});

// The preview has to show what will be in force AFTER saving.
//
// It was `{...serverEffective, ...draftOverrides}`, and `serverEffective` already CONTAINS the saved
// overrides — so removing one could not remove its price from the preview. An operator pressed the bin,
// saw the old override price still on screen, and saved a table where that model had gone back to its
// shipped default, or to nothing at all. The file's own comment two lines up promised the opposite.
describe('Pricing view — the preview after an edit', () => {
  it('drops an override\'s price when the row is removed', async () => {
    serve();
    wrap(<Pricing />);
    await screen.findByText('acme/new-model');

    fireEvent.click(screen.getByLabelText('remove override for acme/new-model'));

    // 10 / 30 was the override. With it gone the model has no shipped price at all, so the preview must
    // stop claiming one rather than keep showing the number that is about to disappear.
    await waitFor(() => {
      expect(screen.queryByText('acme/new-model'), 'the removed override is still priced in the preview').toBeNull();
    });
  });

  it('still shows a model that has a shipped default after its override is removed', async () => {
    // The other direction: removing an override on gpt-4o falls BACK to $2.50, it does not unprice it.
    // A preview that dropped the row entirely would be wrong in the opposite way.
    serve({
      ...RESPONSE,
      overrides: { 'gpt-4o': { inputPer1M: 99, outputPer1M: 99 } },
      effective: { ...RESPONSE.effective, 'gpt-4o': { inputPer1M: 99, outputPer1M: 99 } },
    });
    wrap(<Pricing />);
    await screen.findByText('gpt-4o');

    fireEvent.click(screen.getByLabelText('remove override for gpt-4o'));
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeTruthy());
  });
});

// Adding a model must not unprice one.
//
// `Add` was disabled only when the id was already an OVERRIDE, and seeded every new row with 0/0. So
// typing `gpt-4o` — a model the shipped table prices at $2.50 — laid an inputPer1M:0 row over it, and
// Save wrote that. The screen for adding tomorrow's model silently unpriced one of today's, which is
// what the server-side comment says this editor must never do.
describe('Pricing view — adding a model that already has a price', () => {
  it('seeds the row from the price it is replacing, not from zero', async () => {
    serve();
    wrap(<Pricing />);
    await screen.findByText('gpt-4o');

    fireEvent.change(screen.getByLabelText('new model id'), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('2.5');
      expect(inputs.length, 'the new row started at 0 and would have unpriced gpt-4o on save').toBeGreaterThan(0);
    });
  });

  it('still starts a genuinely unknown model at zero', async () => {
    // The fallback is unchanged for the case Add exists for: an id nothing prices yet.
    serve();
    wrap(<Pricing />);
    await screen.findByText('gpt-4o');

    fireEvent.change(screen.getByLabelText('new model id'), { target: { value: 'nobody/prices-this' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(screen.getByText('nobody/prices-this')).toBeTruthy());
  });
});
