import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AddHostProjectControl1791770000000 } from '../src/database/migrations/1791770000000-add-host-project-control';
import { AddHostProjectFiles1791763200000 } from '../src/database/migrations/1791763200000-add-host-project-files';

const TABLES = [
  'file_uploads',
  'media_assets',
  'workflows',
  'workflow_triggers',
  'media_jobs',
  'workflow_runs',
  'batch_tasks',
] as const;

async function main() {
  const databaseUrl = process.env.FLOW_TEST_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log('flow-schema-migrations.integration: SKIP (FLOW_TEST_DATABASE_URL is not set)');
    return;
  }

  const schema = `flow_schema_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: databaseUrl });
  let dataSource: DataSource | undefined;
  let schemaCreated = false;

  try {
    await admin.connect();
    const result = await admin.query<{ current_database: string }>('SELECT current_database()');
    const databaseName = result.rows[0]?.current_database ?? '';
    if (!databaseName.endsWith('_test')) {
      throw new Error('FLOW_TEST_DATABASE_URL must point to a disposable database ending in _test');
    }

    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    for (const table of TABLES) {
      await admin.query(
        `CREATE TABLE "${schema}"."${table}" ("id" uuid PRIMARY KEY, "legacy_marker" text NOT NULL)`,
      );
      await admin.query(
        `INSERT INTO "${schema}"."${table}" ("id", "legacy_marker") VALUES ($1, $2)`,
        [randomUUID(), `preserve-${table}`],
      );
    }

    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('application_name', `flow_schema_${schema}`);
    dataSource = new DataSource({
      type: 'postgres',
      url: isolatedUrl.toString(),
      schema,
      migrations: [
        AddHostProjectFiles1791763200000,
        AddHostProjectControl1791770000000,
      ],
      migrationsTableName: 'typeorm_migrations',
      migrationsRun: false,
      synchronize: false,
      logging: false,
      extra: { options: `-c search_path=${schema}` },
    });
    await dataSource.initialize();

    const applied = await dataSource.runMigrations({ transaction: 'all' });
    assert.deepEqual(
      applied.map((migration) => migration.name),
      [
        'AddHostProjectFiles1791763200000',
        'AddHostProjectControl1791770000000',
      ],
      'both production migrations run through TypeORM in timestamp order',
    );

    const rows = await dataSource.query<Array<{ table_name: string; legacy_marker: string }>>(
      TABLES.map(
        (table) => `SELECT '${table}' AS table_name, legacy_marker FROM "${table}"`,
      ).join(' UNION ALL '),
    );
    assert.deepEqual(
      rows.map((row) => row.legacy_marker).sort(),
      TABLES.map((table) => `preserve-${table}`).sort(),
      'pre-existing rows survive both migrations',
    );

    const columns = await dataSource.query<Array<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1`,
      [schema],
    );
    const nullableColumns = [
      ['file_uploads', 'hostProjectId'],
      ['media_assets', 'hostProjectId'],
      ['workflows', 'hostProjectId'],
      ['workflows', 'hostLayoutVersion'],
      ['workflow_triggers', 'hostProjectBinding'],
      ['media_jobs', 'hostProjectBinding'],
      ...(['workflow_runs', 'media_jobs', 'batch_tasks'] as const).flatMap((table) => [
        [table, 'hostProjectId'],
        [table, 'hostGeneration'],
      ]),
      ['workflow_runs', 'remoteStatus'],
      ['media_jobs', 'remoteStatus'],
      ['workflow_runs', 'hostExecutionTarget'],
      ['batch_tasks', 'hostProjectBinding'],
    ];
    for (const [tableName, columnName] of nullableColumns) {
      assert.equal(
        columns.find((column) => column.table_name === tableName && column.column_name === columnName)
          ?.is_nullable,
        'YES',
        `${tableName}.${columnName} remains nullable for existing rows`,
      );
    }

    const indexes = await dataSource.query<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    );
    const indexNames = new Set(indexes.map((index) => index.indexname));
    for (const indexName of [
      'IDX_file_uploads_host_project',
      'IDX_media_assets_host_project',
      'IDX_workflows_host_project',
      'IDX_workflow_runs_project_generation',
      'IDX_media_jobs_project_generation',
      'IDX_batch_tasks_project_generation',
    ]) {
      assert.ok(indexNames.has(indexName), `registered index ${indexName} exists`);
    }

    const registered = await dataSource.query<Array<{ name: string }>>(
      'SELECT name FROM typeorm_migrations ORDER BY timestamp',
    );
    assert.deepEqual(
      registered.map((migration) => migration.name),
      ['AddHostProjectFiles1791763200000', 'AddHostProjectControl1791770000000'],
      'TypeORM records both forward migrations',
    );
    console.log('flow-schema-migrations.integration: PASS');
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
