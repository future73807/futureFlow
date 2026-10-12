import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHostProjectFiles1791763200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['file_uploads', 'media_assets', 'workflows']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "hostProjectId" uuid NULL`);
      await queryRunner.query(`CREATE INDEX "IDX_${table}_host_project" ON "${table}" ("hostProjectId")`);
    }
    await queryRunner.query('ALTER TABLE "workflows" ADD COLUMN "hostLayoutVersion" char(64) NULL');
    await queryRunner.query('ALTER TABLE "workflow_triggers" ADD COLUMN "hostProjectBinding" jsonb NULL');
    await queryRunner.query('ALTER TABLE "media_jobs" ADD COLUMN "hostProjectBinding" jsonb NULL');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "workflow_triggers" DROP COLUMN "hostProjectBinding"');
    await queryRunner.query('ALTER TABLE "media_jobs" DROP COLUMN "hostProjectBinding"');
    await queryRunner.query('ALTER TABLE "workflows" DROP COLUMN "hostLayoutVersion"');
    for (const table of ['file_uploads', 'media_assets', 'workflows']) {
      await queryRunner.query(`DROP INDEX "IDX_${table}_host_project"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "hostProjectId"`);
    }
  }
}
