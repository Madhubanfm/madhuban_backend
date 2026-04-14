#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CRON_BASE_URL:-}" ]]; then
  echo "CRON_BASE_URL is required (example: http://127.0.0.1:3000)" >&2
  exit 1
fi

if [[ -z "${CRON_ADMIN_EMAIL:-}" ]]; then
  echo "CRON_ADMIN_EMAIL is required" >&2
  exit 1
fi

if [[ -z "${CRON_ADMIN_PASSWORD:-}" ]]; then
  echo "CRON_ADMIN_PASSWORD is required" >&2
  exit 1
fi

TOKEN="$(
  curl -fsS -X POST "$CRON_BASE_URL/api/auth/login" \
    -H "content-type: application/json" \
    -d "{\"email\":\"$CRON_ADMIN_EMAIL\",\"password\":\"$CRON_ADMIN_PASSWORD\"}" \
  | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).token"
)"

curl -fsS -X POST "$CRON_BASE_URL/api/cron/daily-tasks" \
  -H "authorization: Bearer $TOKEN"

