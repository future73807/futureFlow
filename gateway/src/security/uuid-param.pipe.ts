import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

/**
 * 路径参数 UUID 校验的统一入口。
 *
 * 为什么需要：路由里的 `:id` 会直接进入 uuid 列的查询条件。客户端在拿不到 id
 * 时可能拼出 `/workflows/undefined/...`（例如画布还没加载完就点了试运行），
 * PostgreSQL 会抛 `invalid input syntax for type uuid: "undefined"`，最终以 500
 * 暴露给调用方，并在日志里留下一段指向数据库、却与真实原因无关的堆栈。
 * 在参数层拦下来，非法 id 直接返回 400。
 *
 * 为什么放在控制器而不是 Service：Service 层的单元测试允许使用
 * `'workflow-cleanup'` 这类可读假 id，格式校验属于 HTTP 边界职责。
 * 这与 `knowledge.controller.ts` 原先的 `assertDatasetId` 思路一致。
 *
 * 注意：不是所有 `:id` 都是 uuid。插件目录（`llm`、`http`）、工作流模板
 * （`chat-assistant`）和 Webhook 密钥都不是 uuid，不要套用本 pipe。
 */
export function uuidParamPipe(label: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new BadRequestException(`${label}格式无效`),
  });
}

export const WORKFLOW_ID_PIPE = uuidParamPipe('工作流 ID');
export const TRIGGER_ID_PIPE = uuidParamPipe('触发器 ID');
export const TASK_ID_PIPE = uuidParamPipe('任务 ID');
export const USER_ID_PIPE = uuidParamPipe('用户 ID');
export const API_KEY_ID_PIPE = uuidParamPipe('API Key ID');
export const MCP_SERVER_ID_PIPE = uuidParamPipe('MCP 服务器 ID');
export const FILE_ID_PIPE = uuidParamPipe('文件 ID');
export const DATASET_ID_PIPE = uuidParamPipe('知识库 ID');
export const DOCUMENT_ID_PIPE = uuidParamPipe('知识文档 ID');
export const MEDIA_ASSET_ID_PIPE = uuidParamPipe('媒体资源 ID');
