#!/bin/sh
# Failover testi kurulumu (yalnız test compose'u — prod değil!).
# 1) Replikasyon/bağlantı izni: pg_basebackup + walreceiver için trust.
echo "host replication all all trust" >> "$PGDATA/pg_hba.conf"
echo "host all all all trust" >> "$PGDATA/pg_hba.conf"
# 2) SENKRON replikasyon FINAL sunucu için conf'a yazılır (komut satırıyla verilirse entrypoint'in
#    GEÇİCİ init sunucusuna da uygulanır ve CREATE DATABASE, henüz bağlanamayan standby'ı bekleyip
#    kilitlenirdi — init bittikten sonra devreye girmesi için buradan).
cat >> "$PGDATA/postgresql.conf" << 'CONF'
synchronous_commit = on
synchronous_standby_names = '*'
CONF
