import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDraftSandboxes1722566400000 implements MigrationInterface {
  name = 'AddDraftSandboxes1722566400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"draft_sandboxes\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"userId\" uuid NOT NULL, \"appId\" varchar(64) NOT NULL, \"dslHash\" char(64) NOT NULL, \"encryptedApiKey\" text NOT NULL, \"createdAt\" timestamp NOT NULL DEFAULT now(), \"updatedAt\" timestamp NOT NULL DEFAULT now(), CONSTRAINT \"PK_draft_sandboxes_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"FK_draft_sandboxes_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE UNIQUE INDEX IF NOT EXISTS \"UQ_draft_sandboxes_user\" ON \"draft_sandboxes\" (\"userId\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "draft_sandboxes"');
  }
}
