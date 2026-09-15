import { MigrationInterface, QueryRunner } from 'typeorm';

/** 为版本历史补充用户说明和来源标记，历史行按发布记录回填默认值。 */
export class AddVersionCommentAndSource1723264000000 implements MigrationInterface {
  name = 'AddVersionCommentAndSource1723264000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 幂等 DDL：已有环境可能被手工添加过列，重复执行不能失败。
    await queryRunner.query(
      `ALTER TABLE "workflow_versions" ADD COLUMN IF NOT EXISTS "comment" text NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_versions" ADD COLUMN IF NOT EXISTS "source" varchar(16) NOT NULL DEFAULT 'publish'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "workflow_versions" DROP COLUMN IF EXISTS "source"',
    );
    await queryRunner.query(
      'ALTER TABLE "workflow_versions" DROP COLUMN IF EXISTS "comment"',
    );
  }
}
