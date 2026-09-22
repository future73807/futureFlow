-- ============================================================
-- 应用运行账号：只拥有 futureflow 库，不是超级用户
-- ============================================================
-- 官方 postgres 镜像把 POSTGRES_USER 建成了 SUPERUSER（实测 rolsuper=t、
-- rolcreatedb=t、rolcreaterole=t）。应用直接用它连库，一旦出现 SQL 注入或
-- 配置泄露，后果就从「读写本库」放大成「控制整个实例（含 Dify 库、任意建删库）」。
--
-- 这份脚本建一个只在本库内的业务账号：
--   * 不是超级用户，不能建库、不能建角色；
--   * 只能连 futureflow 库（不授予其它库的 CONNECT）；
--   * 对 public schema 里的表只有 SELECT/INSERT/UPDATE/DELETE；
--   * 通过 ALTER DEFAULT PRIVILEGES 覆盖迁移之后新建的表。
-- 迁移（DDL）仍由 POSTGRES_USER 通过 `migration:run` 执行，不用这个账号。
--
-- psql 变量：app_user / app_password / db_name / allow_ddl
-- 同一份文件也被 scripts/db-grant-app-user.cjs 渲染后用于存量卷，
-- 改这里就等于改两处，不会分叉。
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password');
  ELSE
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
      :'app_user',
      :'app_password'
    );
  END IF;
END
$$;

-- 只给这一个库的连接权，不给其它库（Dify 库不在此列）
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";

-- 现有表：只有增删改查
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_user";

-- 迁移/同步之后新建的表与序列自动获得同样权限
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";

-- 空的 postgres 维护库默认对 PUBLIC 开放 CONNECT，一并收掉：应用账号不该
-- 出现在自己的库之外。超级用户不受影响（超级用户绕过权限检查）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'postgres') THEN
    EXECUTE 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC';
  END IF;
END
$$;

-- 开发环境 TypeORM 走 synchronize=true：它不只是建表，还会 ALTER 已有表，
-- 而 ALTER 要求**是表的所有者**——光给 schema 的 CREATE 不够（实测报
-- "must be owner of table ..."）。所以开发模式下把本库表/序列的属主转给应用
-- 账号，代价只是它能改自己的库。
--
-- 生产请把 allow_ddl 设为 false：不转属主、不给 CREATE，表结构只由
-- migration:run（用 POSTGRES_USER 超级用户）变更。
DO $$
DECLARE
  obj record;
BEGIN
  IF :'allow_ddl' = 'true' THEN
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', :'app_user');
    FOR obj IN SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO %I', obj.name, :'app_user');
    END LOOP;
    FOR obj IN SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public' LOOP
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', obj.name, :'app_user');
    END LOOP;
  ELSE
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_user');
  END IF;
END
$$;
