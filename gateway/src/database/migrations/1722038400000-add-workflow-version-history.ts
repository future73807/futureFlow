import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds immutable publish history without rewriting or losing existing drafts. */
export class AddWorkflowVersionHistory1722038400000 implements MigrationInterface {
  name = 'AddWorkflowVersionHistory1722038400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workflow_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workflowId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "version" integer NOT NULL,
        "name" varchar(128) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "flowgramJson" jsonb NOT NULL,
        "publishedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflow_versions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workflow_versions_workflow_version" UNIQUE ("workflowId", "version"),
        CONSTRAINT "FK_workflow_versions_workflow" FOREIGN KEY ("workflowId")
          REFERENCES "workflows"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_workflow_versions_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_workflow_versions_workflow_id" ON "workflow_versions" ("workflowId")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_workflow_versions_user_id" ON "workflow_versions" ("userId")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_workflow_versions_workflow_published_at" ON "workflow_versions" ("workflowId", "publishedAt")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "workflow_versions"');
  }
}
