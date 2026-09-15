import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPluginFavorites1723177600000 implements MigrationInterface {
  name = 'AddPluginFavorites1723177600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"plugin_favorites\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"userId\" uuid NOT NULL, \"pluginId\" varchar(64) NOT NULL, \"createdAt\" timestamp NOT NULL DEFAULT now(), CONSTRAINT \"PK_plugin_favorites_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"FK_plugin_favorites_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_plugin_favorites_user\" ON \"plugin_favorites\" (\"userId\")");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_plugin_favorites_plugin\" ON \"plugin_favorites\" (\"pluginId\")");
    // 唯一索引兜底并发收藏，保证同一用户对同一插件只有一条记录。
    await queryRunner.query("CREATE UNIQUE INDEX IF NOT EXISTS \"UQ_plugin_favorites_user_plugin\" ON \"plugin_favorites\" (\"userId\", \"pluginId\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "plugin_favorites"');
  }
}
