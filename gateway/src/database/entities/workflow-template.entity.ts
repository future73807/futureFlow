import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** Curated, versioned starting points. Templates are platform-owned in v1. */
@Entity('workflow_templates')
export class WorkflowTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 80, unique: true })
  @Index()
  slug: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', length: 48, default: 'general' })
  category: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  tags: string[];

  @Column({ type: 'jsonb' })
  flowgramJson: Record<string, any>;

  @Column({ type: 'varchar', default: 'free' })
  requiredVip: string;

  @Column({ type: 'boolean', default: false })
  requiresDify: boolean;

  @Column({ type: 'boolean', default: false })
  featured: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'varchar', default: 'active' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
