import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { HostProjectBinding } from './host.types';

export interface ProjectWorkUnit {
  id: string;
  runId?: string;
  hostSubject: string;
  binding: HostProjectBinding;
  controller: AbortController;
  settled: Promise<void>;
  finish(): Promise<void>;
  assertCurrent(): Promise<void>;
  remoteStop?: () => Promise<boolean>;
  cancel?: () => Promise<void>;
}
export const projectWorkContext = new AsyncLocalStorage<ProjectWorkUnit>();
export function projectAbortSignal(): AbortSignal | undefined { return projectWorkContext.getStore()?.controller.signal; }

export class ProjectWorkUnits {
  readonly active = new Map<string, ProjectWorkUnit>();
  create(hostSubject: string, binding: HostProjectBinding, assert: () => Promise<void>, cleanup: () => Promise<void>, runId?: string): ProjectWorkUnit {
    let settle!: () => void;
    let fail!: (error: unknown) => void;
    const id = randomUUID();
    const unit: ProjectWorkUnit = { id, runId, hostSubject, binding, controller: new AbortController(),
      settled: new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; }), assertCurrent: assert,
      finish: async () => { try { await cleanup(); this.active.delete(id); settle(); } catch (error) { fail(error); throw error; } } };
    void unit.settled.catch(() => undefined);
    this.active.set(id, unit);
    return unit;
  }
  forProject(hostSubject: string, projectId: string): ProjectWorkUnit[] {
    return [...this.active.values()].filter((unit) => unit.hostSubject === hostSubject && unit.binding.projectId === projectId);
  }
}
