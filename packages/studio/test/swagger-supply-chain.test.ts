// /swagger runs third-party code on the studio's OWN origin — the origin whose localStorage holds the
// admin bearer token (studio-ui/src/auth.ts). Whatever that page loads can read the token and drive the
// admin API: purge runs, promote managed agents, invalidate caches.
//
// It loaded `swagger-ui-dist@5` — a FLOATING major — from unpkg, with no integrity attribute and no
// CSP anywhere in the studio server. Publishing any 5.x, or tampering with what unpkg served for that
// URL, put attacker code in that position. Pinning alone is not enough (the CDN still chooses the
// bytes) and SRI alone is not enough (a floating range moves off the hash); both are required.
import { describe, it, expect } from 'vitest';
import { swaggerHtml, SWAGGER_UI_VERSION } from '../src/swagger.js';

const html = () => swaggerHtml('');

describe('the swagger page cannot be turned into an admin-token exfiltrator', () => {
  it('pins an exact version — never a floating range', () => {
    const out = html();
    expect(out).not.toMatch(/swagger-ui-dist@\d+\//); // @5, @5.x → the CDN picks; we do not
    expect(out).toContain(`swagger-ui-dist@${SWAGGER_UI_VERSION}/`);
    expect(SWAGGER_UI_VERSION, 'an exact semver, all three parts').toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('binds every external asset with SRI, so tampered bytes are refused by the browser', () => {
    const out = html();
    const external = [...out.matchAll(/<(?:script|link)[^>]*(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g)];
    expect(external.length, 'both the stylesheet and the bundle come from outside').toBe(2);
    for (const [tag] of external) {
      expect(tag, `no integrity on ${tag.slice(0, 70)}`).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
      expect(tag, 'SRI is not enforced without crossorigin').toContain('crossorigin="anonymous"');
    }
  });

  it('ships a CSP that confines the page to that one origin', () => {
    const out = html();
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(out)?.[1];
    expect(csp, 'the page carries its own policy — it must not depend on a proxy adding a header').toBeDefined();
    expect(csp).toContain("default-src 'none'");
    // The one that matters most: injected code must not be able to POST the token anywhere.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // script-src admits the pinned CDN and the nonced bootstrap, and nothing else.
    const scriptSrc = csp!.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain('https://unpkg.com');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain('*');
  });

  it('nonces the inline bootstrap, with a fresh value per response', () => {
    const nonceOf = (s: string) => /<script nonce="([^"]+)">/.exec(s)?.[1];
    const a = nonceOf(html());
    const b = nonceOf(html());
    expect(a).toBeTruthy();
    // A constant nonce is no nonce: injected markup would simply reuse it.
    expect(a).not.toBe(b);
    // Within ONE render the CSP must name the SAME nonce the script carries, or the browser drops it.
    const one = html();
    expect(one).toContain(`'nonce-${nonceOf(one)}'`);
  });

  it('every inline script in the page is nonced — an un-nonced one silently would not run', () => {
    const out = html();
    for (const [tag] of out.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)) {
      expect(tag, `inline script without a nonce: ${tag}`).toMatch(/nonce="/);
    }
  });
});
