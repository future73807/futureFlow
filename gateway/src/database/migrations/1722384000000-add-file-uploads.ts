import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileUploads1722384000000 implements MigrationInterface {
  name = 'AddFileUploads1722384000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"file_uploads\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"userId\" uuid NOT NULL, \"originalName\" varchar(255) NOT NULL, \"mimeType\" varchar(120) NOT NULL, \"sizeBytes\" bigint NOT NULL, \"sha256\" char(64) NOT NULL, \"localPath\" text NOT NULL, \"createdAt\" timestamp NOT NULL DEFAULT now(), CONSTRAINT \"PK_file_uploads_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"FK_file_uploads_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_file_uploads_user_created\" ON \"file_uploads\" (\"userId\", \"createdAt\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "file_uploads"');
  }
}
