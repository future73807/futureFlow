#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  futureFlow full stack startup"
echo "  PostgreSQL + Dify + Sandbox + SSRF Proxy + app"
echo "============================================================"

command -v pnpm >/dev/null || { echo "pnpm is required: npm i -g pnpm"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }

pnpm install --prod=false
pnpm start
