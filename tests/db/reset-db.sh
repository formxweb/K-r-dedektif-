#!/usr/bin/env bash
# Yerel test veritabanını sıfırdan kurar: Supabase taklidi + tüm migration'lar.
set -euo pipefail
DB_URL_ADMIN="${KD_TEST_ADMIN_URL:-postgresql://postgres@127.0.0.1:54329/postgres}"
DB_NAME="${KD_TEST_DB:-kd_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
psql "$DB_URL_ADMIN" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME"
DB_URL="${DB_URL_ADMIN%/*}/$DB_NAME"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "alter database $DB_NAME set search_path = \"\$user\", public, extensions"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/tests/db/supabase-stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null || { echo "FAILED: $f"; exit 1; }
done
echo "ok: $DB_URL"
