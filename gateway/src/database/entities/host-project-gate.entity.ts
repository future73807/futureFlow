import type { ProjectControlReceipt } from '../../host/project-control.types';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('host_project_gates')
export class HostProjectGate {
  @PrimaryColumn({ type: 'varchar', length: 256 }) hostSubject: string;
  @PrimaryColumn({ type: 'uuid' }) projectId: string;
  @Column({ type: 'int', default: 1 }) generation: number;
  @Column({ type: 'boolean', default: false }) draining: boolean;
  @Column({ type: 'uuid', nullable: true }) operationId: string | null;
}

@Entity('host_project_controls')
export class HostProjectControlRecord {
  @PrimaryColumn({ type: 'varchar', length: 256 }) hostSubject: string;
  @PrimaryColumn({ type: 'uuid' }) projectId: string;
  @PrimaryColumn({ type: 'uuid' }) operationId: string;
  @PrimaryColumn({ type: 'varchar', length: 24 }) action: string;
  @Column({ type: 'int' }) expectedGeneration: number;
  @Column({ type: 'jsonb', nullable: true }) receipt: ProjectControlReceipt | null;
}

@Entity('host_project_work_units')
export class HostProjectWorkRecord {
  @PrimaryColumn({ type: 'uuid' }) id: string;
  @Column({ type: 'varchar', length: 256 }) hostSubject: string;
  @Column({ type: 'uuid' }) projectId: string;
  @Column({ type: 'int' }) generation: number;
  @Column({ type: 'uuid', nullable: true }) runId: string | null;
}
