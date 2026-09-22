#!/bin/sh
# 仅在**全新数据卷**上由 postgres 镜像的 initdb 执行一次。
# 已有数据卷请用：node scripts/db-grant-app-user.cjs
set -eu

: "${POSTGRES_APP_USER:=futureflow_app}"
: "${POSTGRES_APP_PASSWORD:=}"
: "${POSTGRES_DB:=futureflow}"
: "${POSTGRES_APP_ALLOW_DDL:=true}"

if [ -z "$POSTGRES_APP_PASSWORD" ]; then
  echo "POSTGRES_APP_PASSWORD 为空，跳过应用账号创建。" >&2
  echo "应用将回退到 POSTGRES_USER 连接（仅建议本机开发）。" >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_user="$POSTGRES_APP_USER" \
  -v app_password="$POSTGRES_APP_PASSWORD" \
  -v db_name="$POSTGRES_DB" \
  -v allow_ddl="$POSTGRES_APP_ALLOW_DDL" \
  -f /opt/futureflow/app-user.sql
