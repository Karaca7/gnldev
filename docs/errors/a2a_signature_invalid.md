# a2a_signature_invalid

**HTTP 401**

## What happened

Both headers were present and the timestamp was inside the window, but the HMAC did not match. The
server recomputed `HMAC-SHA256(secret, ${timestamp}.${rawBody})` over the bytes it actually received
and compared the result with `x-gnl-signature` using a constant-time comparison.

## Why

**The refusal says nothing about which part was wrong**, and cannot: a wrong secret, a body that
changed in flight, and a signature computed over a different serialisation all produce the same
mismatch. That is the property being bought — a signature that could tell you *how close* you were
would be a signature you could search.

**Compared with `timingSafeEqual`.** A byte-by-byte early-exit comparison leaks, through response
timing, how many leading bytes were correct, which turns forging into a few thousand requests instead
of an impossible number. Length is checked first for the same reason the comparison is constant-time.

**Signed over the RAW body, not over the parsed object.** This is the failure people actually hit:
sign the JSON string, then let a client library re-serialise it, and the bytes on the wire are no
longer the bytes that were signed — different key order, different unicode escaping, a re-added
whitespace. The signature is valid, over something that was never sent.

## What to do

**Confirm the secret matches on both sides.** Same string, no trailing newline from a file read, same
environment as the one you think you deployed.

**Sign and send the same bytes.** Build the body string once, HMAC that exact string, send that exact
string. Any middleware between your signing code and the socket that reformats the body invalidates
the signature — which is what it is for.

**Check the signature encoding.** The header is lowercase hex of the digest, not base64.

**If none of that explains it**, treat it as what it is designed to report: a message that did not
come intact from a holder of the secret. Look at what is between the two agents before assuming a
bug.
