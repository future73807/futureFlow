/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FC, useState, useEffect } from 'react';

import classnames from 'classnames';
import { IReport, WorkflowInputs, WorkflowOutputs } from '@flowgram.ai/runtime-interface';
import { useService } from '@flowgram.ai/free-layout-editor';
import { Button, Switch } from '@douyinfe/semi-ui';
import { IconClose, IconDownload, IconPlay, IconSpin } from '@douyinfe/semi-icons';

import { TestRunJsonInput } from '../testrun-json-input';
import { TestRunForm } from '../testrun-form';
import { NodeStatusGroup } from '../node-status-bar/group';
import {
  WORKFLOW_RUNTIME_SERVICE,
  WorkflowRuntimeService,
} from '../../../plugins/runtime-plugin/runtime-service';
import { useTestRunFormPanel } from '../../../plugins/panel-manager-plugin/hooks';
import { IconCancel } from '../../../assets/icon-cancel';
import { downloadResultArchive, extractTextOutput } from '../../../utils/result-archive';

import styles from './index.module.less';

export interface TestRunSidePanelProps {}

export const TestRunSidePanel: FC<TestRunSidePanelProps> = () => {
  const runtimeService = useService<WorkflowRuntimeService>(WORKFLOW_RUNTIME_SERVICE);
  const { close: closePanel } = useTestRunFormPanel();
  const [isRunning, setRunning] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<string[]>();
  const [report, setReport] = useState<IReport>();
  const [result, setResult] = useState<
    | {
        inputs: WorkflowInputs;
        outputs: WorkflowOutputs;
      }
    | undefined
  >();

  // en - Use localStorage to persist the JSON mode state
  const [inputJSONMode, _setInputJSONMode] = useState(() => {
    const savedMode = localStorage.getItem('testrun-input-json-mode');
    return savedMode ? JSON.parse(savedMode) : false;
  });

  const setInputJSONMode = (checked: boolean) => {
    _setInputJSONMode(checked);
    localStorage.setItem('testrun-input-json-mode', JSON.stringify(checked));
  };

  const onTestRun = async () => {
    if (isRunning) {
      await runtimeService.taskCancel();
      return;
    }
    setResult(undefined);
    setErrors(undefined);
    setReport(undefined);
    const taskID = await runtimeService.taskRun(values);
    if (taskID) {
      setRunning(true);
    }
  };

  const onClose = async () => {
    await runtimeService.taskCancel();
    setValues({});
    setRunning(false);
    closePanel();
  };

  const renderRunning = (
    <div className={styles['testrun-panel-running']}>
      <IconSpin aria-hidden="true" spin size="large" />
      <div className={styles.text}>运行中...</div>
    </div>
  );

  const renderForm = (
    <div className={styles['testrun-panel-form']}>
      <div className={styles['testrun-panel-input']}>
        <div className={styles.title}>输入表单</div>
        <div>JSON 模式</div>
        <Switch
          checked={inputJSONMode}
          onChange={(checked: boolean) => setInputJSONMode(checked)}
          size="small"
        />
      </div>
      {inputJSONMode ? (
        <TestRunJsonInput values={values} setValues={setValues} />
      ) : (
        <TestRunForm values={values} setValues={setValues} />
      )}
      {errors?.map((e) => (
        <div className={styles.error} key={e}>
          {e}
        </div>
      ))}
      <NodeStatusGroup title="输入结果" data={result?.inputs} optional disableCollapse />
      <NodeStatusGroup title="输出结果" data={result?.outputs} optional disableCollapse />
    </div>
  );

  const renderButton = (
    <Button
      onClick={onTestRun}
      aria-label={isRunning ? '取消试运行' : '开始试运行'}
      icon={isRunning
        ? <IconCancel aria-hidden="true" />
        : <IconPlay aria-hidden="true" size="small" />}
      className={classnames(styles.button, {
        [styles.running]: isRunning,
        [styles.default]: !isRunning,
      })}
    >
      {isRunning ? '取消' : '试运行'}
    </Button>
  );

  const renderDownloadButton = !isRunning && (result || errors?.length) ? (
    <Button
      aria-label="打包下载试运行结果"
      className={styles['download-button']}
      icon={<IconDownload aria-hidden="true" />}
      theme="light"
      type="primary"
      onClick={() => void downloadResultArchive({
        workflowName: '本地试运行',
        status: result ? '执行成功' : '执行失败',
        outputs: result?.outputs as Record<string, unknown> | undefined,
        inputs: result?.inputs as Record<string, unknown> | undefined,
        text: extractTextOutput(result?.outputs as Record<string, unknown> | undefined),
        nodes: report ? Object.values(report.reports) : [],
        statistics: report ? {
          status: report.workflowStatus.status,
          startTime: report.workflowStatus.startTime,
          endTime: report.workflowStatus.endTime,
          elapsedTime: report.workflowStatus.timeCost,
          nodeCount: Object.keys(report.reports).length,
        } : undefined,
        error: errors?.join('\n'),
      })}
    >
      打包下载 ZIP
    </Button>
  ) : null;

  useEffect(() => {
    const disposer = runtimeService.onResultChanged(({ result, errors, report }) => {
      setRunning(false);
      setResult(result);
      setReport(report);
      if (errors) {
        setErrors(errors);
      } else {
        setErrors(undefined);
      }
    });
    return () => disposer.dispose();
  }, []);

  useEffect(
    () => () => {
      runtimeService.taskCancel();
    },
    [runtimeService]
  );

  return (
    <div className={styles['testrun-panel-container']}>
      <div className={styles['testrun-panel-header']}>
        <div className={styles['testrun-panel-title']}>试运行</div>
        <Button
          aria-label="关闭试运行面板"
          className={styles['testrun-panel-title']}
          type="tertiary"
          icon={<IconClose aria-hidden="true" />}
          size="small"
          theme="borderless"
          onClick={onClose}
        />
      </div>
      <div className={styles['testrun-panel-content']}>
        {isRunning ? renderRunning : renderForm}
      </div>
      <div className={styles['testrun-panel-footer']}>
        {renderButton}
        {renderDownloadButton}
      </div>
    </div>
  );
};
