import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 账号显示名（`ff-embed` 内嵌模式的账号互通）。
 *
 * 内嵌形态下宿主是身份权威：宿主在下发身份时带 `displayName`（KenFutWork 账号的
 * 展示名 / 邮箱前缀），flow 侧存下来并在界面显示——用户在 flow 里看到的不再是
 * `host-<hash>` 这样的派生用户名，而是和宿主一致的账号身份。
 * 派生用户名（username）仍是稳定的登录/外键键，不动。
 */
export class AddUserDisplayName1790290000000 implements MigrationInterface {
  name = 'AddUserDisplayName1790290000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "displayName" character varying(128)`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "users"."displayName" IS '账号显示名（内嵌模式由宿主下发同步；独立模式可空，界面回退用户名）'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "displayName"`,
    );
  }
}
