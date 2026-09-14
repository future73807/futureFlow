import { BadRequestException, Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface PythonExecPayload {
  code?: string;
  params?: unknown;
}

const MAX_CODE_LENGTH = 50_000;
const EXEC_TIMEOUT_MS = 15_000;
const RESULT_MARKER = '__FF_RESULT__';

const RUNNER_SOURCE = `import json, sys

params = {}
if len(sys.argv) > 1:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        params = json.load(f)

with open(sys.argv[2], 'r', encoding='utf-8') as f:
    source = f.read()

code = compile(source, 'main.py', 'exec')
scope = {'__name__': '__main__'}
exec(code, scope)

main = scope.get('main')
if not callable(main):
    print(json.dumps({'error': 'Python 脚本必须定义 main 函数'}, ensure_ascii=False))
    raise SystemExit(2)

try:
    result = main({'params': params})
except Exception as exc:
    print(json.dumps({'error': f'{type(exc).__name__}: {exc}'}, ensure_ascii=False))
    raise SystemExit(3)

print('__FF_RESULT__' + json.dumps(result, ensure_ascii=False, default=str))
`;

/**
 * 本地 Python 执行代理（「Python 执行」节点专用）
 *
 * 浏览器试运行时没有 Python 运行时，由网关调用本机 Python 完成执行：
 * - 与 JS 代码节点一致的同步 main({params}) 契约
 * - 每次执行使用独立临时目录，15 秒超时强杀，进程结束后清理
 * - 已知边界：不做依赖白名单、资源配额与网络隔离，仅面向本机开发场景
 */
@UseGuards(JwtAuthGuard)
@Controller('python')
export class PythonExecController {
  private readonly logger = new Logger(PythonExecController.name);
  private pythonCommand: string | null = null;
  private pythonCheck: Promise<string | null> | null = null;

  private detectPython(): Promise<string | null> {
    if (this.pythonCommand) return Promise.resolve(this.pythonCommand);
    if (this.pythonCheck) return this.pythonCheck;
    this.pythonCheck = new Promise((resolve) => {
      const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
      let index = 0;
      const tryNext = () => {
        if (index >= candidates.length) {
          resolve(null);
          return;
        }
        const candidate = candidates[index++];
        const probe = spawn(candidate, ['-c', 'print(1)'], { timeout: 5_000 });
        probe.on('error', () => tryNext());
        probe.on('close', (code) => {
          if (code === 0) {
            this.pythonCommand = candidate;
            resolve(candidate);
          } else {
            tryNext();
          }
        });
      };
      tryNext();
    });
    return this.pythonCheck;
  }

  @Post('exec')
  async exec(@Request() req: any, @Body() payload: PythonExecPayload) {
    if (!req?.user?.id) throw new BadRequestException('未认证');
    const code = payload.code || '';
    if (!code.trim()) throw new BadRequestException('Python 代码不能为空');
    if (code.length > MAX_CODE_LENGTH) {
      throw new BadRequestException(`Python 代码长度不能超过 ${MAX_CODE_LENGTH} 个字符`);
    }

    const python = await this.detectPython();
    if (!python) {
      throw new BadRequestException('未检测到本机 Python，请安装 Python 3 后重试');
    }

    const dir = await mkdtemp(join(tmpdir(), 'ff-py-'));
    const userFile = join(dir, 'main.py');
    const runnerFile = join(dir, 'runner.py');
    const paramsFile = join(dir, 'params.json');
    try {
      await writeFile(userFile, code, 'utf8');
      await writeFile(runnerFile, RUNNER_SOURCE, 'utf8');
      await writeFile(paramsFile, JSON.stringify(payload.params ?? {}), 'utf8');

      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(python, [runnerFile, paramsFile, userFile], {
          cwd: dir,
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += String(d); });
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('error', (e) => reject(new BadRequestException(`无法启动 Python: ${e.message}`)));
        child.on('close', (exitCode, signal) => {
          if (signal === 'SIGTERM') {
            reject(new BadRequestException('Python 执行超时（15 秒上限）'));
            return;
          }
          if (exitCode !== 0) {
            const markerIndex = err.indexOf('Traceback');
            const detail = (err || out).trim().split('\n').filter(Boolean).slice(-3).join('\n');
            reject(new BadRequestException(
              detail || `Python 执行失败（退出码 ${exitCode ?? markerIndex}）`,
            ));
            return;
          }
          resolve(out);
        });
      });

      const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_MARKER));
      if (!line) {
        throw new BadRequestException('Python 脚本未返回结果（main 需要返回一个对象）');
      }
      const raw = line.slice(RESULT_MARKER.length);
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        result = raw;
      }
      return { result };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}