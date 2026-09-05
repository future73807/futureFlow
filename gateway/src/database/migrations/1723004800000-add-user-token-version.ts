import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserTokenVersion1723004800000 implements MigrationInterface {
  name = 'AddUserTokenVersion1723004800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。存量用户默认 0，与既有 JWT 的隐式版本兼容。
    await queryRunner.query("ALTER TABLE \"users\" ADD COLUMN IF NOT EXISTS \"tokenVersion\" integer NOT NULL DEFAULT 0");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "users" DROP COLUMN IF EXISTS "tokenVersion"');
  }
}
