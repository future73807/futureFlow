import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores the Dify bridge credentials encrypted at rest. */
export class AddDifyIntegration1722124800000 implements MigrationInterface {
  name = 'AddDifyIntegration1722124800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dify_integrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" varchar(64) NOT NULL DEFAULT 'default',
        "workflowId" uuid,
        "workflowVersion" integer,
        "appId" varchar(128),
        "consoleBase" varchar(512) NOT NULL,
        "encryptedApiKey" text,
        "encryptedConsoleToken" text,
        "encryptedConsoleRefreshToken" text,
        "keyFingerprint" varchar(64),
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "lastRotatedAt" timestamp,
        "lastConsoleAuthorizedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dify_integrations_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dify_integrations_name" UNIQUE ("name")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_dify_integrations_workflow_version" ON "dify_integrations" ("workflowId", "workflowVersion")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "dify_integrations"');
  }
}
