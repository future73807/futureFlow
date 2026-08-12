/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  IReport,
  NodeReport,
  WorkflowInputs,
  WorkflowOutputs,
  WorkflowStatus,
} from '@flowgram.ai/runtime-interface';
import {
  injectable,
  inject,
  WorkflowDocument,
  Playground,
  WorkflowLineEntity,
  WorkflowNodeEntity,
  Emitter,
} from '@flowgram.ai/free-layout-editor';

import { WorkflowRuntimeClient } from '../client';
import { GetGlobalVariableSchema } from '../../variable-panel-plugin';
import { WorkflowNodeType } from '../../../nodes';
import { prepareContentNodesForRuntime } from '../../../nodes/content/runtime';
import { prepareHttpNodesForRuntime } from '../../../nodes/http/runtime';
import { prepareVariableNodesForRuntime } from '../../../nodes/variable/runtime';
import { prepareCodeNodesForRuntime } from '../../../nodes/code/runtime';
import { prepareConditionNodesForRuntime } from '../../../nodes/condition/runtime';

const SYNC_TASK_REPORT_INTERVAL = 500;

/**
 * Keep the runtime service identifier stable across development hot updates.
 *
 * Inversify normally accepts a class as the service identifier, but a hot
 * update creates a new class object while the editor container still holds
 * the previous binding. A global symbol keeps consumers and the existing
 * container on the same identifier until the editor is disposed normally.
 */
export const WORKFLOW_RUNTIME_SERVICE = Symbol.for(
  'futureFlow.workflow-runtime-service'
);

const localizeRuntimeMessage = (message: string): string => message
  .replace(/\bLLM node\b/gi, '大语言模型节点')
  .replace(/\bHTTP node\b/gi, 'API 请求节点')
  .replace(/\bCode node\b/gi, '代码节点')
  .replace(/^HTTP url is required$/i, 'API 请求地址不能为空')
  .replace(/^HTTP (?:json|form-data|x-www-form-urlencoded|binary) body is required$/i, 'API 请求体不能为空')
  .replace(/^HTTP invalid body type "([^"]*)"$/i, 'API 请求体类型“$1”不受支持')
  .replace(/^HTTP request failed after all retry attempts$/i, 'API 请求已完成全部重试但仍失败')
  .replace(/The operation was aborted due to timeout/gi, 'API 请求超时')
  .replace(/The operation was aborted/gi, 'API 请求已中止')
  .replace(/Failed to fetch|fetch failed|NetworkError when attempting to fetch resource/gi, '网络请求失败，请检查地址、跨域策略或网络连接')
  .replace(/Invalid URL|Failed to construct ['"]URL['"]/gi, 'API 请求地址格式无效')
  .replace(/^Code content is required$/i, '代码内容不能为空')
  .replace(/^main function is required in the script$/i, '代码中必须声明 main 函数')
  .replace(/^Unsupported code language "([^"]*)"$/i, '暂不支持代码语言“$1”')
  .replace(/^Code execution failed:\s*/i, '代码执行失败：')
  .replace(/\s+missing required inputs?:\s*/gi, '缺少必填项：')
  .replace(/"apiKey"/g, '“API 密钥”')
  .replace(/"apiHost"/g, '“API 地址”')
  .replace(/"modelName"/g, '“模型名称”')
  .replace(/"prompt"/g, '“用户提示词”')
  .replace(/”,\s*“/g, '”、“');

interface NodeRunningStatus {
  nodeID: string;
  status: WorkflowStatus;
  nodeResultLength: number;
}

@injectable()
export class WorkflowRuntimeService {
  @inject(Playground) playground: Playground;

  @inject(WorkflowDocument) document: WorkflowDocument;

  @inject(WorkflowRuntimeClient) runtimeClient: WorkflowRuntimeClient;

  @inject(GetGlobalVariableSchema) getGlobalVariableSchema: GetGlobalVariableSchema;

  private runningNodes: WorkflowNodeEntity[] = [];

  private taskID?: string;

  private syncTaskReportIntervalID?: ReturnType<typeof setInterval>;

  private reportEmitter = new Emitter<NodeReport>();

  private resetEmitter = new Emitter<{}>();

  private resultEmitter = new Emitter<{
    errors?: string[];
    report?: IReport;
    result?: {
      inputs: WorkflowInputs;
      outputs: WorkflowOutputs;
    };
  }>();

  private nodeRunningStatus: Map<string, NodeRunningStatus>;

  public onNodeReportChange = this.reportEmitter.event;

  public onReset = this.resetEmitter.event;

  public onResultChanged = this.resultEmitter.event;

  public isFlowingLine(line: WorkflowLineEntity) {
    return this.runningNodes.some((node) => node.lines.inputLines.includes(line));
  }

  public async taskRun(inputs: WorkflowInputs): Promise<string | undefined> {
    if (this.taskID) {
      await this.taskCancel();
    }
    const isFormValid = await this.validateForm();
    if (!isFormValid) {
      this.resultEmitter.fire({
        errors: ['节点配置校验未通过'],
      });
      return;
    }
    let schema: ReturnType<WorkflowDocument['toJSON']> & { globalVariable: unknown };
    try {
      schema = prepareConditionNodesForRuntime(prepareCodeNodesForRuntime(
        prepareHttpNodesForRuntime(prepareContentNodesForRuntime(
          prepareVariableNodesForRuntime({
            ...this.document.toJSON(),
            globalVariable: this.getGlobalVariableSchema(),
          }),
        )),
      ));
    } catch (error) {
      this.resultEmitter.fire({
        errors: [localizeRuntimeMessage((error as Error)?.message || '变量配置无效')],
      });
      return;
    }

    const validateResult = await this.runtimeClient.TaskValidate({
      schema: JSON.stringify(schema),
      inputs,
    });
    if (!validateResult?.valid) {
      this.resultEmitter.fire({
        errors: validateResult?.errors?.map(localizeRuntimeMessage) ?? ['运行时内部错误'],
      });
      return;
    }
    this.reset();
    let taskID: string | undefined;
    try {
      const output = await this.runtimeClient.TaskRun({
        schema: JSON.stringify(schema),
        inputs,
      });
      taskID = output?.taskID;
    } catch (e) {
      this.resultEmitter.fire({
        errors: [localizeRuntimeMessage((e as Error)?.message || '工作流启动失败')],
      });
      return;
    }
    if (!taskID) {
      this.resultEmitter.fire({
        errors: ['工作流启动失败'],
      });
      return;
    }
    this.taskID = taskID;
    this.syncTaskReportIntervalID = setInterval(() => {
      this.syncTaskReport();
    }, SYNC_TASK_REPORT_INTERVAL);
    return this.taskID;
  }

  public async taskCancel(): Promise<void> {
    if (!this.taskID) {
      return;
    }
    await this.runtimeClient.TaskCancel({
      taskID: this.taskID,
    });
  }

  private async validateForm(): Promise<boolean> {
    const allForms = this.document.getAllNodes().map((node) => node.form);
    const formValidations = await Promise.all(allForms.map(async (form) => form?.validate()));
    const validations = formValidations.filter((validation) => validation !== undefined);
    const isValid = validations.every((validation) => validation);
    return isValid;
  }

  private reset(): void {
    this.taskID = undefined;
    this.nodeRunningStatus = new Map();
    this.runningNodes = [];
    if (this.syncTaskReportIntervalID) {
      clearInterval(this.syncTaskReportIntervalID);
    }
    this.resetEmitter.fire({});
  }

  private async syncTaskReport(): Promise<void> {
    if (!this.taskID) {
      return;
    }
    const report = await this.runtimeClient.TaskReport({
      taskID: this.taskID,
    });
    if (!report) {
      clearInterval(this.syncTaskReportIntervalID);
      console.error('同步运行报告失败');
      return;
    }
    const { workflowStatus, inputs, outputs, messages } = report;
    if (workflowStatus.terminated) {
      clearInterval(this.syncTaskReportIntervalID);
      if (workflowStatus.status === WorkflowStatus.Succeeded) {
        this.resultEmitter.fire({ result: { inputs, outputs }, report });
      } else {
        this.resultEmitter.fire({
          errors: messages?.error?.length
            ? messages.error.map((message) =>
                message.nodeID
                  ? `${message.nodeID}: ${localizeRuntimeMessage(message.message)}`
                  : localizeRuntimeMessage(message.message)
              )
            : [`工作流${workflowStatus.status === WorkflowStatus.Cancelled ? '已取消' : '执行失败'}`],
          report,
        });
      }
    }
    this.updateReport(report);
  }

  private updateReport(report: IReport): void {
    const { reports } = report;
    this.runningNodes = [];
    this.document
      .getAllNodes()
      .filter(
        (node) =>
          ![WorkflowNodeType.BlockStart, WorkflowNodeType.BlockEnd].includes(
            node.flowNodeType as WorkflowNodeType
          )
      )
      .forEach((node) => {
        const nodeID = node.id;
        const nodeReport = reports[nodeID];
        if (!nodeReport) {
          return;
        }
        if (nodeReport.status === WorkflowStatus.Processing) {
          this.runningNodes.push(node);
        }
        const runningStatus = this.nodeRunningStatus.get(nodeID);
        if (
          !runningStatus ||
          nodeReport.status !== runningStatus.status ||
          nodeReport.snapshots.length !== runningStatus.nodeResultLength
        ) {
          this.nodeRunningStatus.set(nodeID, {
            nodeID,
            status: nodeReport.status,
            nodeResultLength: nodeReport.snapshots.length,
          });
          this.reportEmitter.fire(nodeReport);
          this.document.linesManager.forceUpdate();
        } else if (nodeReport.status === WorkflowStatus.Processing) {
          this.reportEmitter.fire(nodeReport);
        }
      });
  }
}
