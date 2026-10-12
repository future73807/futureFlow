export interface ProjectControlInput {
  action: 'snapshot' | 'quiesce' | 'complete-relink'; hostSubject: string;
  operationId: string; expectedGeneration: number;
}
export interface ProjectControlReceipt {
  projectId: string; generation: number; draining: boolean; localSettled: boolean;
  activeRunIds: string[]; remoteStopped: number; remoteOutstanding: number;
  operationId: string | null; quiesceSettled: boolean;
}
