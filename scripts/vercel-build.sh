#!/usr/bin/env bash
# Builds the whole app for Vercel using the Build Output API (v3):
#   static  -> React app (apps/web/dist)
#   api.func -> single bundled Node function with the Hono API
set -euo pipefail

if [ -n "${DATABASE_URL:-}" ]; then
  echo "Applying database migrations…"
  pnpm --filter @agenda/api db:migrate
  pnpm --filter @agenda/api db:seed-missing || echo "Demo seed skipped"
  pnpm --filter @agenda/api whatsapp:setup || echo "WhatsApp templates skipped"
else
  echo "DATABASE_URL not set: skipping migrations"
fi

pnpm --filter @agenda/web build
pnpm --filter @agenda/api build:vercel

OUT=.vercel/output
rm -rf "$OUT"
mkdir -p "$OUT/static" "$OUT/functions/api.func"
cp -r apps/web/dist/. "$OUT/static/"
cp apps/api/dist-vercel/index.mjs "$OUT/functions/api.func/index.mjs"
# App page with link-preview tags filled in per business (/b/<slug>, routes/share.ts)
cp apps/web/dist/index.html "$OUT/functions/api.func/app.html"

cat > "$OUT/functions/api.func/.vc-config.json" <<'JSON'
{
  "runtime": "nodejs22.x",
  "handler": "index.mjs",
  "launcherType": "Nodejs",
  "shouldAddHelpers": false,
  "maxDuration": 300
}
JSON

cat > "$OUT/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "^/api/(.*)$", "dest": "/api?__path=$1" },
    { "src": "^/b/([^/]+)/?$", "dest": "/api?__path=page/b/$1" },
    { "handle": "filesystem" },
    { "src": "^/(.*)$", "dest": "/index.html" }
  ],
  "crons": [
    { "path": "/api/cron/reminders", "schedule": "0 16 * * *" },
    { "path": "/api/cron/reset-demo", "schedule": "0 9 * * *" }
  ]
}
JSON

echo "Build output ready in $OUT"
