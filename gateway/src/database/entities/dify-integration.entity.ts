import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Dify control-plane connection and immutable published-workflow bindings.
 *
 * `name = default` holds only the Console authorization. Every published
 * futureFlow version gets its own Dify app and Service API key, indexed by
 * `workflowId + workflowVersion`. Plain credentials are AES-GCM encrypted
 * before persistence; the encryption secret remains in the deployment
 * environment.
 */
@Entity('dify_integrations')
export class DifyIntegration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true, default: 'default' })
  @Index()
  name: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_dify_integrations_workflow_version')
  workflowId: string | null;

  @Column({ type: 'int', nullable: true })
  workflowVersion: number | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  appId: string | null;

  @Column({ type: 'varchar', length: 512 })
  consoleBase: string;

  @Column({ type: 'text', nullable: true })
  encryptedApiKey: string | null;

  @Column({ type: 'text', nullable: true })
  encryptedConsoleToken: string | null;

  @Column({ type: 'text', nullable: true })
  encryptedConsoleRefreshToken: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  keyFingerprint: string | null;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status: 'active' | 'provisioning' | 'reauthorization_required' | 'disabled';

  @Column({ type: 'timestamp', nullable: true })
  lastRotatedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastConsoleAuthorizedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
