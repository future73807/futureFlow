import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 宿主适配层（`ff-embed` 内嵌模式）的身份稳定键。
 *
 * 内嵌形态下身份由宿主签发：同一个宿主用户反复换取会话必须命中**同一行** flow 用户，
 * 因此按 `hostSubject` 做 get-or-create。它与用户名 / 邮箱这些可变的展示字段无关，
 * 独立模式恒为 NULL（唯一索引允许多个 NULL）。
 */
export class AddUserHostSubject1790280000000 implements MigrationInterface {
  name = 'AddUserHostSubject1790280000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hostSubject" character varying(255)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "users_host_subject_unique" ON "users" ("hostSubject")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "users_host_subject_unique"');
    await queryRunner.query(
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "hostSubject"',
    );
  }
}
