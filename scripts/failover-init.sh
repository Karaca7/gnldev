#!/bin/sh
# Failover test setup (test compose only — not prod!).
# 1) Replication/connection permission: trust for pg_basebackup + walreceiver.
echo "host replication all all trust" >> "$PGDATA/pg_hba.conf"
echo "host all all all trust" >> "$PGDATA/pg_hba.conf"
# 2) SYNCHRONOUS replication is written to conf for the FINAL server (if passed via command line,
#    it would also apply to the entrypoint's TEMPORARY init server, and CREATE DATABASE would wait
#    on a standby that can't connect yet and deadlock — hence applying it here, after init finishes).
cat >> "$PGDATA/postgresql.conf" << 'CONF'
synchronous_commit = on
synchronous_standby_names = '*'
CONF
