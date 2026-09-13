# a2a_signature_missing

**HTTP 401**

## What happened

The deployment verifies agent-to-agent message signatures, and this request arrived without them.
Both headers are required and neither was present:

```
x-gnl-timestamp: 1735689600000
x-gnl-signature: <hex HMAC-SHA256 of `${timestamp}.${rawBody}`>
```

## Why

**A second layer, independent of the auth gate.** Authentication asks who is calling and what they
may do; the signature asks whether this exact message is the one that was sent, by someone holding
the shared secret. A caller can be perfectly authenticated and still deliver a body that was altered
in transit or replayed from a proxy log — that is the gap this closes, which is why both gates are
opt-in and neither substitutes for the other.

**Missing is refused, not treated as "unsigned traffic".** Once a deployment turns signing on, an
unsigned request is the interesting one: it is either a caller that was never configured with the
secret, or something that is not the caller at all. Letting it through on the grounds that it made no
claim would make the control decorative.

## What to do

**Call through `@gnldev/a2a`'s tool rather than hand-rolling the request.** `createA2ATool({ secret })`
sets both headers over the exact bytes it sends, and the signature is computed over the RAW body — a
client that re-serialises the JSON after signing produces a valid-looking signature over different
bytes (see `a2a_signature_invalid`).

**If you are the operator**: the calling agent needs the same secret this deployment verifies with.
The header names are fixed; there is no fallback spelling.

**If you did not mean to require signatures**, verification only runs when a secret is configured on
this side. Removing it restores the previous behaviour exactly — but do that because you decided the
control is not for you, not to clear the error.
