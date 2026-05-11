#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "[deploy] Installing dependencies..."
npm ci

echo "[deploy] Generating Prisma client..."
npx prisma generate

echo "[deploy] Building Next.js..."
npm run build

echo "[deploy] Restarting PM2..."
if pm2 describe madhuban > /dev/null 2>&1; then
  pm2 restart madhuban
else
  pm2 start npm --name madhuban -- run start
fi

pm2 save

echo "[deploy] Done."
