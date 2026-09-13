# dead_scan_timeout

**HTTP 504 · operator console**

## What happened

One dead-letter scan ran past its time budget and was abandoned. Nothing was modified — a scan is a
read.

(Housekeeping note: this was the fifth operator-console code on the wire while the old exclusion
comment counted four — the drift that made these pages and the `STUDIO_ERROR_CODES` map worth
having.)

## Why the framework can't guess

The budget exists so a wedged store cannot hold an operator request open forever; how long a scan
*should* take is a property of your store's size and health, which the console cannot know.

## What to do

- Retry once the store is healthy; repeated timeouts usually escalate into
  [`dead_scan_store_wedged`](./dead_scan_store_wedged.md), which is the same diagnosis with a
  louder name.
- If your dead-letter namespace is legitimately huge, raise the scan budget in the Studio options
  rather than retrying into the same wall.
