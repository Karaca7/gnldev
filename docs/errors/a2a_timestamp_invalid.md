# a2a_timestamp_invalid

**HTTP 401**

## What happened

The signed agent-to-agent request carried an `x-gnl-timestamp` that is not a finite number, or that
sits more than **300 seconds** away from this server's clock in either direction. The signature was
not even checked — the window is tested first.

## Why

**A signature alone does not expire.** Without a time window, a correctly signed message stays
correctly signed forever: anything that once captured a request — a proxy log, an error report, a
mirrored packet — can send it again next month and it verifies. The timestamp is what makes a
signature a statement about *now*, and it is inside the signed material (`${timestamp}.${rawBody}`)
so an attacker cannot simply update it.

**Both directions, on purpose.** A timestamp far in the FUTURE is refused as firmly as an old one: a
skewed or attacker-chosen clock reading would otherwise mint a token valid for as long as it likes.

**±300s rather than something tighter**, because the window has to survive ordinary clock drift
between two independent hosts. It is the replay window, so it is also the number to think about if
you are deciding whether it is short enough for you.

## What to do

**Check the clock on the CALLING host first.** This is a clock-skew error far more often than an
attack — an unsynchronised container or a VM resumed from a snapshot is the usual story. NTP on both
sides ends it.

**Send milliseconds, not seconds.** The value is compared against `Date.now()`. A caller sending Unix
seconds is off by a factor of a thousand and lands decades away from the window, which reads exactly
like a replay.

**Do not retry a stored request.** If your retry path replays a previously built body and headers, it
will keep failing here as the original timestamp ages out — and correctly so. Rebuild and re-sign on
each attempt; that is what `createA2ATool` does.
