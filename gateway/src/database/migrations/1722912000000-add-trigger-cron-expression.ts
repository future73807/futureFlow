import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTriggerCronExpression1722912000000 implements MigrationInterface {
  name = 'AddTriggerCronExpression1722912000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("ALTER TABLE \"workflow_triggers\" ADD COLUMN IF NOT EXISTS \"cronExpression\" varchar(120)");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "workflow_triggers" DROP COLUMN IF EXISTS "cronExpression"');
  }
}
