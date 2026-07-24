import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the mutable singleton Dify target with one application and one
 * encrypted Service API key per published workflow version. The default row
 * remains the encrypted Console authorization used to provision those apps.
 */
export class AddDifyWorkflowIsolation1722211200000 implements MigrationInterface {
  name = 'AddDifyWorkflowIsolation1722211200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "dify_integrations" ADD COLUMN IF NOT EXISTS "workflowId" uuid');
    await queryRunner.query('ALTER TABLE "dify_integrations" ADD COLUMN IF NOT EXISTS "workflowVersion" integer');
    await queryRunner.query('ALTER TABLE "dify_integrations" ALTER COLUMN "appId" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "dify_integrations" ALTER COLUMN "encryptedApiKey" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "dify_integrations" ALTER COLUMN "keyFingerprint" DROP NOT NULL');
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_dify_integrations_workflow_version" ON "dify_integrations" ("workflowId", "workflowVersion")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_dify_integrations_workflow_version" ON "dify_integrations" ("workflowId", "workflowVersion") WHERE "workflowId" IS NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_dify_integrations_workflow_version"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_dify_integrations_workflow_version"');
    await queryRunner.query('ALTER TABLE "dify_integrations" DROP COLUMN IF EXISTS "workflowVersion"');
    await queryRunner.query('ALTER TABLE "dify_integrations" DROP COLUMN IF EXISTS "workflowId"');
  }
}
