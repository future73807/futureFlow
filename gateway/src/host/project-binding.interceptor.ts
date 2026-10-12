import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { parseProjectBinding, projectBindingContext } from './project-files.provider';
import { ProjectControlService } from './project-control.service';
import { projectWorkContext, type ProjectWorkUnit } from './project-work-units';

@Injectable()
export class ProjectBindingInterceptor implements NestInterceptor {
  constructor(private readonly control: ProjectControlService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const binding = parseProjectBinding(request.auth?.projectFiles);
    return new Observable((subscriber) => {
      let cancelled = false;
      let unit: ProjectWorkUnit | undefined;
      let finish: (() => Promise<void>) | undefined;
      const start = async () => {
        unit = binding ? await this.control.begin(request.user.id, binding) : undefined;
        finish = async () => { await unit?.finish(); };
        if (cancelled) { await finish(); return; }
        const subscribe = () => next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => { void finish?.().then(() => subscriber.error(error), (failure) => subscriber.error(failure)); },
          complete: () => { void finish?.().then(() => subscriber.complete(), (failure) => subscriber.error(failure)); },
        });
        projectBindingContext.run(binding, () => unit ? projectWorkContext.run(unit, subscribe) : subscribe());
      };
      void start().catch((error) => subscriber.error(error));
      return () => { cancelled = true; unit?.controller.abort(); /* 保持内部订阅直到真实handler完成，不能把unsubscribe当停止 */ };
    });
  }
}
