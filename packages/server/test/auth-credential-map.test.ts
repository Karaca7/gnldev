// The host-level half of the credential-map fail-open.
//
// @gnldev/studio already refused this shape (resolveConfigAuth, expose.ts) after it shipped once.
// @gnldev/server passes `opts.auth` straight to normalizeAuth, which used to read any unrecognised
// object as a {read, write} pair with neither direction present — i.e. a provider that authorises
// everything. So the identical mistake produced a wide-open REST API here while the Studio surface
// was protected, and nothing said so: the server started, the option was accepted, and every request
// was allowed.
//
// This asserts the refusal at the HOST, not just at the helper, because "the helper throws" and "the
// server cannot be started this way" are different claims and only the second one is the guarantee.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const model = () => ({
  specificationVersion: 'v2',
  provider: 'mock',
  modelId: 'm',
  supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  }),
}) as never;

const base = () => ({ journal: new InMemoryJournal(), agents: { a: { model: model() } } }) as never;
/** `auth` belongs to the SECOND argument (RestApiOptions), not to the agent config. */
const start = (auth: unknown) => createRestApi(base(), { auth } as never);

describe('createRestApi with a credential map as `auth`', () => {
  it('refuses to start rather than starting unprotected', () => {
    expect(() => start({ admin: { token: 's3cret' }, viewer: { token: 'v' } }))
      .toThrow(/roleAuth/);
  });

  it('the refusal names what would have happened, not just that it is invalid', () => {
    expect(() => start({ admin: { token: 's3cret' } }))
      .toThrow(/authorise every request/);
  });

  it('an omitted `auth` is still allowed — this does not force everyone to configure auth', () => {
    expect(() => start(undefined)).not.toThrow();
  });
});
