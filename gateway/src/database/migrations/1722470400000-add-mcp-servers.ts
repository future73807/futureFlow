import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMcpServers1722470400000 implements MigrationInterface {
  name = 'AddMcpServers1722470400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"mcp_servers\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"userId\" uuid NOT NULL, \"name\" varchar(80) NOT NULL, \"url\" varchar(500) NOT NULL, \"encryptedToken\" text, \"createdAt\" timestamp NOT NULL DEFAULT now(), CONSTRAINT \"PK_mcp_servers_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"FK_mcp_servers_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_mcp_servers_user_created\" ON \"mcp_servers\" (\"userId\", \"createdAt\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "mcp_servers"');
  }
}
