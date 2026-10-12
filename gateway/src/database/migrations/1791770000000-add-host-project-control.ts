import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddHostProjectControl1791770000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE host_project_gates ("hostSubject" varchar(256) NOT NULL, "projectId" uuid NOT NULL, generation integer NOT NULL DEFAULT 1, draining boolean NOT NULL DEFAULT false, "operationId" uuid NULL, PRIMARY KEY ("hostSubject", "projectId"))`);
    await queryRunner.query(`CREATE TABLE host_project_controls ("hostSubject" varchar(256) NOT NULL, "projectId" uuid NOT NULL, "operationId" uuid NOT NULL, action varchar(24) NOT NULL, "expectedGeneration" integer NOT NULL, receipt jsonb NULL, PRIMARY KEY ("hostSubject", "projectId", "operationId", action))`);
    await queryRunner.query(`CREATE TABLE host_project_work_units (id uuid PRIMARY KEY, "hostSubject" varchar(256) NOT NULL, "projectId" uuid NOT NULL, generation integer NOT NULL, "runId" uuid NULL)`);
    for (const table of ['workflow_runs', 'media_jobs', 'batch_tasks']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "hostProjectId" uuid NULL, ADD COLUMN "hostGeneration" integer NULL`);
      await queryRunner.query(`CREATE INDEX "IDX_${table}_project_generation" ON "${table}" ("hostProjectId", "hostGeneration")`);
    }
    for (const table of ['workflow_runs', 'media_jobs']) await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "remoteStatus" varchar(24) NULL`);
    await queryRunner.query('ALTER TABLE workflow_runs ADD COLUMN "hostExecutionTarget" jsonb NULL');
    await queryRunner.query('ALTER TABLE batch_tasks ADD COLUMN "hostProjectBinding" jsonb NULL');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE batch_tasks DROP COLUMN "hostProjectBinding"');
    await queryRunner.query('ALTER TABLE workflow_runs DROP COLUMN "hostExecutionTarget"');
    for (const table of ['workflow_runs', 'media_jobs']) await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "remoteStatus"`);
    for (const table of ['workflow_runs', 'media_jobs', 'batch_tasks']) {
      await queryRunner.query(`DROP INDEX "IDX_${table}_project_generation"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "hostProjectId", DROP COLUMN "hostGeneration"`);
    }
    await queryRunner.query('DROP TABLE host_project_work_units');
    await queryRunner.query('DROP TABLE host_project_controls'); await queryRunner.query('DROP TABLE host_project_gates');
  }
}
