// @vitest-environment jsdom
// Gelen kutusu KİMİN işi olduğunu söyler, ve söylediğiyle tutarlı davranır.
//
// Motorun sahiplik kilidi son kullanıcının damgasını taşıyan bir koşumu operatöre kapatıyor (409
// run_actor_mismatch). Ekran bunu bilmiyordu: her satırın Onayla/Reddet çifti açıktı, operatör
// kullanıcı işini basıp-409-okuyarak keşfediyordu. Satır GİZLENMİYOR — görünürlük adminde kalır —
// ama işaretleniyor ve eylem kapanıyor.
//
// KİLİT İKİ İSİM İSTER. `owner` (resourceId) tek başına reddi getirmez; `ownerActor` getirir. Bu
// dosyanın orta testi tam da o ayrımı tutuyor: sahipli ama damgasız satırda düğmeler AÇIK kalmalı,
// çünkü motor o resume'u kabul ediyor — kapatmak, sunucunun izin verdiği işi kullanıcıya yasaklamak olurdu.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Approvals } from '../src/views/Approvals';
import en from '../src/i18n/locales/en/approvals.json';

afterEach(() => { cleanup(); localStorage.clear(); });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : []) };
  }));
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}
/** The view only polls when the capability is on (usePolled) — same setup as views.test.tsx. */
const show = (items: unknown[]) => {
  stubFetch({ '/approvals': { items }, '/capabilities': { approvals: true } });
  wrap(<Approvals />);
};
const btn = (name: string) => screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement;

describe('Approvals: sahiplik rozeti ve kilitli eylem', () => {
  it('damgalı kullanıcı işi işaretlenir ve Onayla/Reddet kapanır — sebebi de yazılı', async () => {
    show([{ runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard', owner: 'u-ayse', ownerActor: 'ayse' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());

    expect(screen.getByText('user work · u-ayse'), 'satır kimin işi olduğunu söylemiyor').toBeTruthy();
    expect(btn(en.approve).disabled, 'kullanıcı işinde Onayla hâlâ basılabilir').toBe(true);
    expect(btn(en.deny).disabled).toBe(true);
    // Açıklama SATIR İÇİNDE de var: `title` yalnız fare ile gelir — klavye ve dokunmatik için hiçbir şey.
    // İki ölü düğmenin sebebini yalnız hover'la anlatmak, kullanıcıların yarısına hiç anlatmamaktır.
    const why = en.ownerLockedTitle.replace('{{owner}}', 'u-ayse');
    expect(screen.getByText(why)).toBeTruthy();
    expect(btn(en.approve).getAttribute('title')).toBe(why);
  });

  it('SAHİPLİ AMA DAMGASIZ: rozet var, düğmeler AÇIK (kilit ateşlemiyor, 409 gelmeyecek)', async () => {
    show([{ runId: 'sus-2', toolCallId: 'call-2', toolName: 'chargeCard', owner: 'u-ayse' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());

    expect(screen.getByText('user work · u-ayse')).toBeTruthy();
    expect(btn(en.approve).disabled, 'motorun kabul edeceği bir iş arayüzde yasaklandı').toBe(false);
    expect(btn(en.deny).disabled).toBe(false);
    expect(screen.queryByText(/belongs to/), 'cevaplanabilir satıra sahiplik uyarısı basıldı').toBeNull();
  });

  it('org işi (sahipsiz) rozetsiz kalır ve eylemi açıktır', async () => {
    // Rozetsizlik bilinçli: gelen kutusunun çoğunluğu org işi (batch, scheduler), ve her satıra
    // rozet basmak gürültüdür. Agents.tsx'in dili de bu — yalnız org-kapsamlı ajan çip alır.
    show([{ runId: 'sus-3', toolCallId: 'call-3', toolName: 'chargeCard' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());

    expect(screen.queryByText(/^user work · /)).toBeNull();
    expect(btn(en.approve).disabled).toBe(false);
  });
});
