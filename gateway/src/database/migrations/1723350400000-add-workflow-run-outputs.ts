import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 运行记录回看历史结果：保存执行结束时的输出与各节点执行摘要。
 * 老数据保持 NULL，前端按“暂无结果快照”降级展示。
 */
export class AddWorkflowRunOutputs1723350400000 implements MigrationInterface {
  name = 'AddWorkflowRunOutputs1723350400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "outputs" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "nodeResults" jsonb`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "nodeResults"',
    );
    await queryRunner.query(
      'ALTER TABLE "workflow_runs" DROP COLUMN IF EXISTS "outputs"',
    );
  }
}
