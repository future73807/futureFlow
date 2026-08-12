import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { ApiKey } from './entities/api-key.entity';
import { BalanceLog } from './entities/balance-log.entity';
import { User } from './entities/user.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { Workflow } from './entities/workflow.entity';
import { WorkflowVersion } from './entities/workflow-version.entity';
import { WorkflowTemplate } from './entities/workflow-template.entity';
import { WorkflowTrigger } from './entities/workflow-trigger.entity';
import { DifyIntegration } from './entities/dify-integration.entity';
import { InitialPlatformSchema1721952000000 } from './migrations/1721952000000-initial-platform-schema';
import { AddWorkflowVersionHistory1722038400000 } from './migrations/1722038400000-add-workflow-version-history';
import { AddDifyIntegration1722124800000 } from './migrations/1722124800000-add-dify-integration';
import { AddDifyWorkflowIsolation1722211200000 } from './migrations/1722211200000-add-dify-workflow-isolation';
import { MediaCredential } from './entities/media-credential.entity';
import { MediaJob } from './entities/media-job.entity';
import { MediaAsset } from './entities/media-asset.entity';
import { AddNativeMedia1722297600000 } from './migrations/1722297600000-add-native-media';

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

// The full-stack starter may have to select a non-default host PostgreSQL
// port. Load its generated runtime override before user .env files so manual
// migration commands keep targeting the already-running futureFlow database.
loadEnvFile(resolve(process.cwd(), '.futureflow.runtime.env'));
loadEnvFile(resolve(process.cwd(), '..', '.futureflow.runtime.env'));
loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '..', '.env'));

const postgresPassword = process.env.POSTGRES_PASSWORD;
if (!postgresPassword) {
  throw new Error('POSTGRES_PASSWORD is required; run pnpm env:init first');
}

export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
  username: process.env.POSTGRES_USER || 'futureflow',
  password: postgresPassword,
  database: process.env.POSTGRES_DB || 'futureflow',
  entities: [
    User,
    ApiKey,
    BalanceLog,
    Workflow,
    WorkflowVersion,
    WorkflowRun,
    WorkflowTemplate,
    WorkflowTrigger,
    DifyIntegration,
    MediaCredential,
    MediaJob,
    MediaAsset,
  ],
  migrations: [
    InitialPlatformSchema1721952000000,
    AddWorkflowVersionHistory1722038400000,
    AddDifyIntegration1722124800000,
    AddDifyWorkflowIsolation1722211200000,
    AddNativeMedia1722297600000,
  ],
  synchronize: false,
  logging: false,
});
