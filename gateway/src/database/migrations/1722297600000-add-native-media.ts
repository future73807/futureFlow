import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNativeMedia1722297600000 implements MigrationInterface {
  name = 'AddNativeMedia1722297600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "media_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "label" varchar(80) NOT NULL,
        "encryptedApiKey" text NOT NULL,
        "fingerprint" varchar(24) NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_media_credentials_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_media_credentials_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_media_credentials_provider"
          CHECK ("provider" IN ('openai', 'google', 'doubao', 'minimax'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "media_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "credentialId" uuid,
        "provider" varchar(32) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "idempotencyKey" varchar(128) NOT NULL,
        "requestHash" char(64) NOT NULL,
        "model" varchar(160) NOT NULL,
        "executionRunId" uuid,
        "executionWorkflowId" uuid,
        "executionWorkflowVersion" integer,
        "status" varchar(24) NOT NULL DEFAULT 'creating',
        "providerTaskId" varchar(512),
        "assetId" uuid,
        "errorCode" varchar(80),
        "completedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_media_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_media_jobs_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_media_jobs_credential" FOREIGN KEY ("credentialId")
          REFERENCES "media_credentials"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_media_jobs_provider"
          CHECK ("provider" IN ('openai', 'google', 'doubao', 'minimax')),
        CONSTRAINT "CHK_media_jobs_kind" CHECK ("kind" IN ('image', 'video')),
        CONSTRAINT "CHK_media_jobs_status"
          CHECK ("status" IN ('creating', 'queued', 'processing', 'succeeded', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "media_assets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "jobId" uuid NOT NULL,
        "mimeType" varchar(80) NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "sha256" char(64) NOT NULL,
        "fileName" varchar(180) NOT NULL,
        "localPath" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_media_assets_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_media_assets_job" UNIQUE ("jobId"),
        CONSTRAINT "FK_media_assets_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_media_assets_job" FOREIGN KEY ("jobId")
          REFERENCES "media_jobs"("id") ON DELETE CASCADE
      )
    `);
    // Development uses TypeORM synchronize. Keep the migration upgrade-safe
    // when an earlier media_jobs table already exists before these scoped
    // execution columns were introduced.
    await queryRunner.query('ALTER TABLE "media_jobs" ADD COLUMN IF NOT EXISTS "executionRunId" uuid');
    await queryRunner.query('ALTER TABLE "media_jobs" ADD COLUMN IF NOT EXISTS "executionWorkflowId" uuid');
    await queryRunner.query('ALTER TABLE "media_jobs" ADD COLUMN IF NOT EXISTS "executionWorkflowVersion" integer');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_media_credentials_user_provider" ON "media_credentials" ("userId", "provider")');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_media_jobs_user_idempotency" ON "media_jobs" ("userId", "idempotencyKey")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_media_jobs_user_created" ON "media_jobs" ("userId", "createdAt")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_media_jobs_execution_run" ON "media_jobs" ("executionRunId")');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_media_assets_user_created" ON "media_assets" ("userId", "createdAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "media_assets"');
    await queryRunner.query('DROP TABLE IF EXISTS "media_jobs"');
    await queryRunner.query('DROP TABLE IF EXISTS "media_credentials"');
  }
}
