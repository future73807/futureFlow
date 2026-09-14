import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBatchTasks1723091200000 implements MigrationInterface {
  name = 'AddBatchTasks1723091200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"batch_tasks\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"userId\" uuid NOT NULL, \"workflowId\" uuid, \"workflowName\" varchar(128) NOT NULL, \"name\" varchar(128) NOT NULL, \"mode\" varchar(20) NOT NULL DEFAULT 'published', \"status\" varchar(20) NOT NULL DEFAULT 'pending', \"totalCount\" integer NOT NULL DEFAULT 0, \"succeededCount\" integer NOT NULL DEFAULT 0, \"failedCount\" integer NOT NULL DEFAULT 0, \"inputs\" jsonb NOT NULL, \"results\" jsonb, \"error\" text, \"createdAt\" timestamp NOT NULL DEFAULT now(), \"updatedAt\" timestamp NOT NULL DEFAULT now(), \"finishedAt\" timestamp, CONSTRAINT \"PK_batch_tasks_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"FK_batch_tasks_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_batch_tasks_user\" ON \"batch_tasks\" (\"userId\")");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_batch_tasks_user_created_at\" ON \"batch_tasks\" (\"userId\", \"createdAt\")");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_batch_tasks_user_status\" ON \"batch_tasks\" (\"userId\", \"status\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "batch_tasks"');
  }
}
