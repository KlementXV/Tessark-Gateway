#!/usr/bin/env bash
# Lance l'environnement de dev complet : DB Postgres (docker compose) puis le serveur Next.js.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env.local ]; then
  echo "Missing .env.local — copy .env.example and fill in real secrets first." >&2
  exit 1
fi

echo "==> Starting dev database (docker compose)"
docker compose -f docker-compose.dev.yml up -d

echo "==> Waiting for Postgres to be healthy"
until [ "$(docker compose -f docker-compose.dev.yml ps -q postgres | xargs docker inspect -f '{{.State.Health.Status}}')" = "healthy" ]; do
  sleep 1
done

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  npm install
fi

echo "==> Starting Next.js dev server"
exec npm run dev
