// bearerAuth / basicAuth — the ready-made StudioAuth.read/write predicates. Both wrap safeEqual
// (constant-time), so the risk isn't just "does it accept the right token" but "does it accept
// anything it shouldn't": wrong scheme, prefix match, case flips, missing header.
import { describe, it, expect } from 'vitest';
import { bearerAuth, basicAuth } from '../src/auth.js';

const req = (authorization?: string): Request =>
  new Request('https://studio.test/runs', authorization ? { headers: { authorization } } : undefined);

describe('bearerAuth', () => {
  const ok = bearerAuth('s3cret');

  it('accepts exactly `Bearer <token>`', () => {
    expect(ok(req('Bearer s3cret'))).toBe(true);
  });

  it('rejects a wrong token, a prefix of it, and a longer superstring', () => {
    expect(ok(req('Bearer wrong'))).toBe(false);
    expect(ok(req('Bearer s3cre'))).toBe(false);
    expect(ok(req('Bearer s3secret-extra'))).toBe(false);
  });

  it('rejects the right token under the wrong scheme, or with no scheme at all', () => {
    expect(ok(req('Basic s3cret'))).toBe(false);
    expect(ok(req('s3cret'))).toBe(false);
    expect(ok(req('bearer s3cret'))).toBe(false); // scheme is compared verbatim
  });

  it('a missing Authorization header is a rejection, not a crash', () => {
    expect(ok(req())).toBe(false);
    expect(ok(req(''))).toBe(false);
  });
});

describe('basicAuth', () => {
  const ok = basicAuth({ user: 'admin', pass: 'hunter2' });
  const encode = (s: string) => 'Basic ' + Buffer.from(s).toString('base64');

  it('accepts base64(user:pass)', () => {
    expect(ok(req(encode('admin:hunter2')))).toBe(true);
  });

  it('rejects a wrong password, a wrong user, and a swapped pair', () => {
    expect(ok(req(encode('admin:wrong')))).toBe(false);
    expect(ok(req(encode('root:hunter2')))).toBe(false);
    expect(ok(req(encode('hunter2:admin')))).toBe(false);
  });

  it('the colon is a real separator — `admin:hunter` + `2` must not pass', () => {
    // guards against a naive concat/startsWith implementation
    expect(ok(req(encode('admin:hunter')))).toBe(false);
    expect(ok(req(encode('adminhunter2')))).toBe(false);
    expect(ok(req(encode('admi:nhunter2')))).toBe(false);
  });

  it('rejects unencoded credentials and a missing header', () => {
    expect(ok(req('Basic admin:hunter2'))).toBe(false);
    expect(ok(req())).toBe(false);
  });

  it('an empty user/pass pair is still compared exactly (no accept-all)', () => {
    const empty = basicAuth({ user: '', pass: '' });
    expect(empty(req(encode(':')))).toBe(true);
    expect(empty(req())).toBe(false);
    expect(empty(req(encode('a:b')))).toBe(false);
  });
});
