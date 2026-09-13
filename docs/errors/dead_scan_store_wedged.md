# dead_scan_store_wedged

**HTTP 503 · operator console**

## What happened

Several dead-letter scans in a row found the work store not answering, and the console stopped
starting new ones (default: after 2 consecutive wedged scans). This is the console protecting the
store, not the console being broken.

## Why the framework can't guess

A store that stops answering mid-scan may be overloaded or partitioned; hammering it with further
full-namespace walks makes both answers worse. Backing off is the only move the console can make
alone.

## What to do

- Check the work store itself (the queue/events backend): connectivity, load, disk. The scans will
  succeed again once it answers.
- The wedge counter resets on the first successful scan — no console restart is needed.
