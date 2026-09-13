# dead_scan_busy

**HTTP 429 · operator console**

## What happened

The dead-letter scanner refused to admit your request. Not because a scan was merely in flight — an
identical request (same topic and consumer) **joins** the running scan and gets its result. This
code means one of two harder limits was hit: you already have the per-caller maximum of scans
outstanding, or the deployment-wide scan queue is saturated and did not clear in time.

## Why the framework can't guess

A scan walks the whole topic log; its cost is the store's, not the console's. One scan runs at a
time deployment-wide, so the console bounds how much can queue up behind it instead of letting
refresh-clicks stack without limit.

## What to do

- Honour the `Retry-After` header on the response — it is estimated from what recent scans actually
  cost, not a fixed number.
- If the refusal names scans *you* already have in flight, wait for one of them; each caller may
  hold only a few at once.
- If scans routinely saturate the queue, the poll interval on the dashboard is shorter than the scan
  itself; lengthen it.
