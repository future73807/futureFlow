import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTriggerDailySchedule1722739200000 implements MigrationInterface {
  name = 'AddTriggerDailySchedule1722739200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("ALTER TABLE \"workflow_triggers\" ADD COLUMN IF NOT EXISTS \"scheduleType\" varchar(16) NOT NULL DEFAULT 'interval'");
    await queryRunner.query("ALTER TABLE \"workflow_triggers\" ADD COLUMN IF NOT EXISTS \"dailyTime\" varchar(5)");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "workflow_triggers" DROP COLUMN IF EXISTS "dailyTime"');
    await queryRunner.query('ALTER TABLE "workflow_triggers" DROP COLUMN IF EXISTS "scheduleType"');
  }
}
