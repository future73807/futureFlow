#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  futureFlow full stack startup"
echo "  PostgreSQL + Dify API/Worker/Web + Redis + Weaviate + app"
echo "============================================================"

command -v pnpm >/dev/null || { echo "pnpm is required: npm i -g pnpm"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }

if [[ ! -f .env ]]; then
  pnpm run env:init
  echo "Created .env with a local Dify credential-encryption secret. Update production secrets before deployment."
fi

pnpm install --prod=false
pnpm start
