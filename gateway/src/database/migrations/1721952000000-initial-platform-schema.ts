import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A migration-safe baseline. Existing development databases may already have
 * these tables from synchronize=true, so DDL is deliberately idempotent.
 */
export class InitialPlatformSchema1721952000000 implements MigrationInterface {
  name = 'InitialPlatformSchema1721952000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "username" varchar NOT NULL,
        "email" varchar,
        "passwordHash" varchar,
        "apiKey" varchar,
        "vipLevel" varchar NOT NULL DEFAULT 'free',
        "role" varchar NOT NULL DEFAULT 'user',
        "status" varchar NOT NULL DEFAULT 'active',
        "balance" numeric(12,4) NOT NULL DEFAULT 0,
        "frozenBalance" numeric(12,4) NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_username" UNIQUE ("username"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflows" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "name" varchar(128) NOT NULL,
        "description" text,
        "flowgramJson" jsonb NOT NULL,
        "status" varchar NOT NULL DEFAULT 'active',
        "version" integer NOT NULL DEFAULT 1,
        "publishedFlowgramJson" jsonb,
        "publishedVersion" integer,
        "publishedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflows_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "workflowId" uuid,
        "triggerId" uuid,
        "source" varchar NOT NULL DEFAULT 'manual',
        "idempotencyKey" varchar(128),
        "status" varchar NOT NULL DEFAULT 'pending',
        "flowgramJson" jsonb,
        "difyWorkflowId" text,
        "difyTaskId" text,
        "totalTokens" integer NOT NULL DEFAULT 0,
        "totalSteps" integer NOT NULL DEFAULT 0,
        "estimatedCost" numeric(12,4) NOT NULL DEFAULT 0,
        "actualCost" numeric(12,4) NOT NULL DEFAULT 0,
        "elapsedTime" float NOT NULL DEFAULT 0,
        "errorMessage" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "finishedAt" timestamp,
        CONSTRAINT "PK_workflow_runs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "name" varchar(64) NOT NULL DEFAULT 'default',
        "keyPrefix" varchar(16) NOT NULL,
        "keyHash" varchar NOT NULL,
        "lastUsedAt" timestamp,
        "expiresAt" timestamp,
        "revoked" boolean NOT NULL DEFAULT false,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_keys_hash" UNIQUE ("keyHash")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "balance_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "type" varchar NOT NULL,
        "amount" numeric(12,4) NOT NULL,
        "balanceAfter" numeric(12,4) NOT NULL,
        "workflowRunId" varchar,
        "remark" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_balance_logs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" varchar(80) NOT NULL,
        "name" varchar(128) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "category" varchar(48) NOT NULL DEFAULT 'general',
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "flowgramJson" jsonb NOT NULL,
        "requiredVip" varchar NOT NULL DEFAULT 'free',
        "requiresDify" boolean NOT NULL DEFAULT false,
        "featured" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "status" varchar NOT NULL DEFAULT 'active',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflow_templates_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workflow_templates_slug" UNIQUE ("slug")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_triggers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "workflowId" uuid NOT NULL,
        "name" varchar(96) NOT NULL,
        "type" varchar(16) NOT NULL,
        "status" varchar NOT NULL DEFAULT 'active',
        "webhookSecretHash" varchar,
        "webhookSecretPrefix" varchar(20),
        "intervalMinutes" integer,
        "staticInputs" jsonb,
        "nextRunAt" timestamp,
        "lastTriggeredAt" timestamp,
        "lastRunStatus" varchar,
        "failureCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflow_triggers_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workflow_triggers_secret_hash" UNIQUE ("webhookSecretHash")
      )
    `);

    await queryRunner.query('ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "publishedFlowgramJson" jsonb');
    await queryRunner.query('ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "publishedVersion" integer');
    await queryRunner.query('ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "publishedAt" timestamp');
    await queryRunner.query('ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "workflowId" uuid');
    await queryRunner.query('ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "triggerId" uuid');
    await queryRunner.query('ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "source" varchar NOT NULL DEFAULT \'manual\'');
    await queryRunner.query('ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(128)');

    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_users_username" ON "users" ("username")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflows_user_id" ON "workflows" ("userId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_user_id" ON "workflow_runs" ("userId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_workflow_id" ON "workflow_runs" ("workflowId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_user_status" ON "workflow_runs" ("userId", "status")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_runs_user_created_at" ON "workflow_runs" ("userId", "createdAt")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_workflow_runs_user_idempotency_key" ON "workflow_runs" ("userId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_api_keys_user_id" ON "api_keys" ("userId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_api_keys_key_hash" ON "api_keys" ("keyHash")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_balance_logs_user_id" ON "balance_logs" ("userId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_templates_slug" ON "workflow_templates" ("slug")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_triggers_workflow_id" ON "workflow_triggers" ("workflowId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_workflow_triggers_due" ON "workflow_triggers" ("type", "status", "nextRunAt")');

    await this.addForeignKey(queryRunner, 'workflows', 'FK_workflows_user', '"userId"', 'users');
    await this.addForeignKey(queryRunner, 'workflow_runs', 'FK_workflow_runs_user', '"userId"', 'users');
    await this.addForeignKey(queryRunner, 'workflow_runs', 'FK_workflow_runs_workflow', '"workflowId"', 'workflows', 'SET NULL');
    await this.addForeignKey(queryRunner, 'api_keys', 'FK_api_keys_user', '"userId"', 'users');
    await this.addForeignKey(queryRunner, 'balance_logs', 'FK_balance_logs_user', '"userId"', 'users');
    await this.addForeignKey(queryRunner, 'workflow_triggers', 'FK_workflow_triggers_user', '"userId"', 'users');
    await this.addForeignKey(queryRunner, 'workflow_triggers', 'FK_workflow_triggers_workflow', '"workflowId"', 'workflows', 'CASCADE');

    for (const template of this.systemTemplates()) {
      await queryRunner.query(
        `INSERT INTO "workflow_templates" ("slug", "name", "description", "category", "tags", "flowgramJson", "requiredVip", "requiresDify", "featured", "sortOrder")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'free', false, true, $7)
         ON CONFLICT ("slug") DO NOTHING`,
        [
          template.slug,
          template.name,
          template.description,
          template.category,
          JSON.stringify(template.tags),
          JSON.stringify(template.flowgramJson),
          template.sortOrder,
        ],
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // This baseline can be applied to an existing synchronized development
    // database, so it cannot safely distinguish platform tables it created
    // from pre-existing business data. A destructive rollback here would be
    // worse than a controlled deployment rollback from backup.
    throw new Error(
      'InitialPlatformSchema is a non-destructive baseline and cannot be rolled back automatically. Restore a verified database backup instead.',
    );
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    table: string,
    name: string,
    column: string,
    targetTable: string,
    onDelete = 'NO ACTION',
  ) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
          ALTER TABLE "${table}" ADD CONSTRAINT "${name}"
          FOREIGN KEY (${column}) REFERENCES "${targetTable}"("id") ON DELETE ${onDelete};
        END IF;
      END $$;
    `);
  }

  private systemTemplates() {
    const template = (
      slug: string,
      name: string,
      description: string,
      category: string,
      tags: string[],
      systemPrompt: string,
      prompt: string,
      sortOrder: number,
    ) => ({
      slug,
      name,
      description,
      category,
      tags,
      sortOrder,
      flowgramJson: {
        nodes: [
          {
            id: 'start_0', type: 'start', data: {
              title: '开始',
              outputs: { type: 'object', properties: { query: { type: 'string', default: '' } } },
            },
          },
          {
            id: 'llm_0', type: 'llm', data: {
              title: 'AI 处理',
              inputsValues: {
                modelName: { type: 'constant', content: 'deepseek-chat' },
                systemPrompt: { type: 'constant', content: systemPrompt },
                prompt: { type: 'template', content: prompt },
              },
            },
          },
          { id: 'end_0', type: 'end', data: { title: '结束' } },
        ],
        edges: [
          { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
          { sourceNodeID: 'llm_0', targetNodeID: 'end_0' },
        ],
      },
    });

    return [
      template('chat-assistant', '智能问答助手', '通用中文问答与任务协助。', 'assistant', ['问答', '通用'], '你是专业、准确的中文助手。', '{{start_0.query}}', 10),
      template('translator', '中英翻译', '保留原意、语气和格式的中英互译。', 'writing', ['翻译', '文本'], '你是资深中英翻译。只输出译文，保留原始格式。', '{{start_0.query}}', 20),
      template('content-outline', '内容大纲生成', '将主题整理为可执行的文章或视频大纲。', 'writing', ['内容', '大纲'], '你是内容策略师。按层级输出清晰、可执行的大纲。', '请为以下主题生成内容大纲：{{start_0.query}}', 30),
    ];
  }
}
