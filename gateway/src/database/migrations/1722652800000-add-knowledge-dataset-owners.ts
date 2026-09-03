import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKnowledgeDatasetOwners1722652800000 implements MigrationInterface {
  name = 'AddKnowledgeDatasetOwners1722652800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 静态 DDL，不含任何用户输入。
    await queryRunner.query("CREATE TABLE IF NOT EXISTS \"knowledge_dataset_owners\" (\"id\" uuid NOT NULL DEFAULT uuid_generate_v4(), \"datasetId\" varchar(64) NOT NULL, \"userId\" uuid NOT NULL, \"createdAt\" timestamp NOT NULL DEFAULT now(), CONSTRAINT \"PK_knowledge_dataset_owners_id\" PRIMARY KEY (\"id\"), CONSTRAINT \"UQ_knowledge_dataset_owners_dataset\" UNIQUE (\"datasetId\"), CONSTRAINT \"FK_knowledge_dataset_owners_user\" FOREIGN KEY (\"userId\") REFERENCES \"users\"(\"id\") ON DELETE CASCADE)");
    await queryRunner.query("CREATE INDEX IF NOT EXISTS \"IDX_knowledge_dataset_owners_user\" ON \"knowledge_dataset_owners\" (\"userId\")");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "knowledge_dataset_owners"');
  }
}
