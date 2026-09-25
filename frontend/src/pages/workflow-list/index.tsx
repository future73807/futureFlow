/**
 * 工作流列表页
 * 参考图布局：标签行（全部/工作流/知识库/文件 + 搜索 + 创建工作流）、发布状态筛选与资源表格。
 */

import {
  IconMore,
  IconPlus,
  IconSearch,
  IconTickCircle,
  IconUpload,
  IconDownload,
} from "@douyinfe/semi-icons";
import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Toast,
  TextArea,
  Typography,
} from "@douyinfe/semi-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import styled from "styled-components";
import { notifyNavigation } from "../../embed/client";
import { useFfEmbedStatus } from "../../embed/react";
import { apiFetch, apiJson } from "../../utils/api";
import { GATEWAY_URL } from "../../utils/config";
import { formatVersionLabel } from "../../utils/version";
import {
  buildWorkflowExport,
  parseWorkflowFile,
} from "../../utils/workflow-io";

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRun {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  source?: string | null;
  totalTokens: number;
  totalSteps: number;
  estimatedCost: number;
  actualCost: number;
  elapsedTime: number;
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

const RUN_SOURCE_LABELS: Record<string, string> = {
  api: "API 调用",
  "draft-run": "云端试运行",
  webhook: "Webhook",
  schedule: "定时调度",
  manual: "手动运行",
};

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  requiredVip: string;
  requiresDify: boolean;
}

interface WorkflowTrigger {
  id: string;
  name: string;
  type: "webhook" | "schedule";
  status: "active" | "paused";
  intervalMinutes?: number | null;
  scheduleType?: "interval" | "daily" | "cron";
  dailyTime?: string | null;
  cronExpression?: string | null;
  staticInputs?: Record<string, string | number | boolean> | null;
  nextRunAt?: string | null;
  lastRunStatus?: string | null;
  lastTriggeredAt?: string | null;
  /** 连续失败次数（成功一次即清零）。用于让「一直失败」的定时任务可见。 */
  failureCount?: number;
}

interface WorkflowVersion {
  id: string;
  version: number;
  name: string;
  description: string;
  publishedAt: string;
}

interface KnowledgeDataset {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  wordCount: number;
  /** 网关当前可能不返回时间字段；有则用于排序与展示，没有则回退为 - */
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface DifyIntegrationStatus {
  encryptionReady: boolean;
  connectionAuthorized: boolean;
  status: "active" | "not_authorized" | "reauthorization_required" | "disabled";
  consoleBase: string | null;
  lastConsoleAuthorizedAt: string | null;
  managedWorkflowAppCount: number;
  managedWorkflowApps: Array<{
    workflowId: string;
    workflowVersion: number;
    appId: string;
    keyFingerprint: string | null;
    lastRotatedAt: string | null;
  }>;
  modelProvider?: {
    provider: string | null;
    model: string | null;
    status:
      | "active"
      | "configured"
      | "not_configured"
      | "unsupported"
      | "disabled";
    configuredNow: boolean;
    message: string;
  };
}

type DifyPreflightState =
  | "passed"
  | "failed"
  | "not_configured"
  | "not_checked";

interface DifyPreflightCheck {
  state: DifyPreflightState;
  message: string;
  version?: string;
}

interface DifyPreflightResult {
  checkedAt: string;
  safe: true;
  consoleBase: string;
  checks: {
    apiHealth: DifyPreflightCheck;
    consoleEndpoint: DifyPreflightCheck;
    credentialEncryption: DifyPreflightCheck;
    storedAuthorization: DifyPreflightCheck;
    provisioning: DifyPreflightCheck;
    modelExecution: DifyPreflightCheck;
  };
  nextStep: string;
}

interface DifySyncResult {
  appId: string | null;
  status: "synced" | "not_configured" | "failed";
  message: string;
}

type ResourceTab = "all" | "workflow" | "dataset" | "file";
type ResourceKind = "workflow" | "dataset" | "file";
type PublishFilter = "all" | "published" | "draft";

const RESOURCE_TABS: Array<{ key: ResourceTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "workflow", label: "工作流" },
  { key: "dataset", label: "知识库" },
  { key: "file", label: "文件" },
];

/** 资源表格前端分页档位：一次列出全部会让长列表难以浏览 */
const PAGE_SIZE_OPTS = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 10;

const TYPE_LABELS: Record<ResourceKind, string> = {
  workflow: "工作流",
  dataset: "知识库",
  file: "文件",
};

/** 表格统一行数据：三类资源在同一个表格中展示 */
interface ResourceRow {
  key: string;
  kind: ResourceKind;
  name: string;
  description: string;
  editedAt: string | null;
  workflow?: Workflow;
  dataset?: KnowledgeDataset;
  file?: StoredFile;
}

/** 统一 YYYY-MM-DD HH:mm 展示；缺失或非法时间回退为 - */
const formatDateTime = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

/** 文件大小按 B / KB / MB 展示 */
const formatFileSize = (bytes?: number | null) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

/** 排序用时间戳；缺失时间统一按 0 处理，排到最后 */
const editedTimeValue = (value?: string | null) => {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? 0 : time;
};

export const WorkflowListPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<ResourceTab>("all");
  const [publishFilter, setPublishFilter] = useState<PublishFilter>("all");
  const [keyword, setKeyword] = useState("");
  // 各 tab 共用一套前端分页状态；切 tab、改搜索/筛选时统一回到第 1 页。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<KnowledgeDataset[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  // 每个数据源只请求一次，标签切换复用缓存；增删改后用 force 重新拉取同步。
  const loadedRef = useRef<Record<ResourceKind, boolean>>({
    workflow: false,
    dataset: false,
    file: false,
  });
  const [createVisible, setCreateVisible] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Workflow | null>(null);
  /** 重命名目标：三种资源统一一个对话框（kind 决定调用哪个端点）。 */
  const [renameTarget, setRenameTarget] = useState<{
    kind: "workflow" | "dataset" | "file";
    id: string;
    name: string;
  } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteDataset, setDeleteDataset] = useState<KnowledgeDataset | null>(
    null,
  );
  const [deleteFile, setDeleteFile] = useState<StoredFile | null>(null);
  // 知识库 / 文件 tab 的创建入口（原在个人中心，收敛到工作流页对应 tab）
  const [datasetCreateVisible, setDatasetCreateVisible] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [uploadDocTarget, setUploadDocTarget] =
    useState<KnowledgeDataset | null>(null);
  const [uploadDocName, setUploadDocName] = useState("");
  const [uploadDocText, setUploadDocText] = useState("");
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [apiWorkflow, setApiWorkflow] = useState<Workflow | null>(null);
  const [runsWorkflow, setRunsWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [versionsWorkflow, setVersionsWorkflow] = useState<Workflow | null>(
    null,
  );
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [templateVisible, setTemplateVisible] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [triggerWorkflow, setTriggerWorkflow] = useState<Workflow | null>(null);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggerCreating, setTriggerCreating] = useState(false);
  const [triggerUpdatingId, setTriggerUpdatingId] = useState<string | null>(
    null,
  );
  const [dailyTimeEdits, setDailyTimeEdits] = useState<Record<string, string>>(
    {},
  );
  const [intervalEdits, setIntervalEdits] = useState<Record<string, string>>(
    {},
  );
  const [cronEdits, setCronEdits] = useState<Record<string, string>>({});
  const [staticInputsEdit, setStaticInputsEdit] = useState<{
    trigger: WorkflowTrigger;
    values: Record<string, string | number | boolean>;
  } | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState<string | null>(null);
  const [difyVisible, setDifyVisible] = useState(false);
  const [difyStatus, setDifyStatus] = useState<DifyIntegrationStatus | null>(
    null,
  );
  const [difyPreflight, setDifyPreflight] =
    useState<DifyPreflightResult | null>(null);
  const [difyLoading, setDifyLoading] = useState(false);
  const [difyPreflighting, setDifyPreflighting] = useState(false);
  const [difyProvisioning, setDifyProvisioning] = useState(false);
  const difySubmitMode = useRef<"validate" | "save">("save");

  const loadWorkflows = useCallback(async (force = false) => {
    if (!force && loadedRef.current.workflow) return;
    loadedRef.current.workflow = true;
    setWorkflowsLoading(true);
    try {
      setWorkflows(await apiJson<Workflow[]>("/workflows"));
      setWorkflowsError(null);
    } catch (error: any) {
      loadedRef.current.workflow = false;
      setWorkflowsError(error.message || "加载工作流列表失败");
      Toast.error(error.message || "加载工作流列表失败");
    } finally {
      setWorkflowsLoading(false);
    }
  }, []);

  const loadDatasets = useCallback(async (force = false) => {
    if (!force && loadedRef.current.dataset) return;
    loadedRef.current.dataset = true;
    setDatasetsLoading(true);
    try {
      setDatasets(await apiJson<KnowledgeDataset[]>("/knowledge/datasets"));
      setDatasetsError(null);
    } catch (error: any) {
      loadedRef.current.dataset = false;
      setDatasetsError(error.message || "加载知识库列表失败");
      Toast.error(error.message || "加载知识库列表失败");
    } finally {
      setDatasetsLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async (force = false) => {
    if (!force && loadedRef.current.file) return;
    loadedRef.current.file = true;
    setFilesLoading(true);
    try {
      setFiles(await apiJson<StoredFile[]>("/files"));
      setFilesError(null);
    } catch (error: any) {
      loadedRef.current.file = false;
      setFilesError(error.message || "加载文件列表失败");
      Toast.error(error.message || "加载文件列表失败");
    } finally {
      setFilesLoading(false);
    }
  }, []);

  // 标签懒加载：进入「全部」并行拉取三类资源，其余标签只加载自己；单个源失败不影响其他源。
  useEffect(() => {
    if (activeTab === "all" || activeTab === "workflow") void loadWorkflows();
    if (activeTab === "all" || activeTab === "dataset") void loadDatasets();
    if (activeTab === "all" || activeTab === "file") void loadFiles();
  }, [activeTab, loadWorkflows, loadDatasets, loadFiles]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      setTemplates(await apiJson<WorkflowTemplate[]>("/workflow-templates"));
    } catch (error: any) {
      Toast.error(error.message || "加载模板库失败");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const openTemplates = useCallback(() => {
    setTemplateVisible(true);
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    const action = searchParams.get("action");
    if (action !== "create" && action !== "templates") return;
    if (action === "create") setCreateVisible(true);
    if (action === "templates") void openTemplates();
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [openTemplates, searchParams, setSearchParams]);

  const openDifySettings = useCallback(async () => {
    setDifyVisible(true);
    setDifyLoading(true);
    try {
      const [status, preflight] = await Promise.all([
        apiJson<DifyIntegrationStatus>("/admin/dify/status"),
        apiJson<DifyPreflightResult>("/admin/dify/preflight"),
      ]);
      setDifyStatus(status);
      setDifyPreflight(preflight);
    } catch (error: any) {
      setDifyStatus(null);
      setDifyPreflight(null);
      Toast.error(
        error.message || "无法读取 Dify 引擎状态；此设置仅管理员可用",
      );
    } finally {
      setDifyLoading(false);
    }
  }, []);

  const runDifyPreflight = useCallback(async () => {
    setDifyPreflighting(true);
    try {
      const preflight = await apiJson<DifyPreflightResult>(
        "/admin/dify/preflight",
      );
      setDifyPreflight(preflight);
      Toast.success(
        "安全预检已完成：未读取或保存管理员凭据，未创建应用或 Key，也未执行模型。",
      );
    } catch (error: any) {
      Toast.error(error.message || "Dify 安全预检失败");
    } finally {
      setDifyPreflighting(false);
    }
  }, []);

  const validateDifyAuthorization = useCallback(
    async (values: {
      consoleBase?: string;
      email?: string;
      password?: string;
      consoleToken?: string;
    }) => {
      setDifyProvisioning(true);
      try {
        await apiJson("/admin/dify/validate-authorization", {
          method: "POST",
          body: JSON.stringify({
            consoleBase: values.consoleBase?.trim() || undefined,
            email: values.email?.trim() || undefined,
            password: values.password || undefined,
            consoleToken: values.consoleToken?.trim() || undefined,
          }),
        });
        Toast.success(
          "管理员授权已验证：未保存凭据，未创建应用或 Key，未执行模型。",
        );
      } catch (error: any) {
        Toast.error(error.message || "Dify 管理员授权验证失败");
      } finally {
        setDifyProvisioning(false);
      }
    },
    [],
  );

  const bootstrapDify = useCallback(
    async (values: {
      consoleBase?: string;
      email?: string;
      password?: string;
      consoleToken?: string;
    }) => {
      setDifyProvisioning(true);
      try {
        const status = await apiJson<DifyIntegrationStatus>(
          "/admin/dify/bootstrap",
          {
            method: "POST",
            body: JSON.stringify({
              consoleBase: values.consoleBase?.trim() || undefined,
              email: values.email?.trim() || undefined,
              password: values.password || undefined,
              consoleToken: values.consoleToken?.trim() || undefined,
            }),
          },
        );
        setDifyStatus(status);
        Toast.success(
          status.modelProvider?.configuredNow
            ? "Dify 已授权，模型 Provider 已验证；发布后即可运行完整工作流"
            : "Dify 已授权；之后每次发布都会自动创建独立应用和加密 Key",
        );
      } catch (error: any) {
        Toast.error(error.message || "Dify 授权或自动建 Key 失败");
      } finally {
        setDifyProvisioning(false);
      }
    },
    [],
  );

  const syncPublishedDify = useCallback(async (id: string) => {
    setDifyProvisioning(true);
    try {
      const result = await apiJson<DifySyncResult>(
        `/workflows/${id}/dify/sync`,
        {
          method: "POST",
        },
      );
      if (result.status === "synced") {
        Toast.success("已同步到该工作流版本专属的 Dify 应用");
      } else {
        Toast.error(result.message);
      }
    } catch (error: any) {
      Toast.error(error.message || "Dify 同步失败，请检查授权和 Dify 模型配置");
    } finally {
      setDifyProvisioning(false);
    }
  }, []);

  const handleCreateFromTemplate = useCallback(
    async (template: WorkflowTemplate) => {
      setCreating(true);
      try {
        const workflow = await apiJson<Workflow>(
          `/workflow-templates/${template.id}/create-workflow`,
          {
            method: "POST",
            body: JSON.stringify({ name: template.name }),
          },
        );
        Toast.success(`已从「${template.name}」创建工作流`);
        setTemplateVisible(false);
        navigate(`/canvas/${workflow.id}`);
      } catch (error: any) {
        Toast.error(error.message || "从模板创建失败");
      } finally {
        setCreating(false);
      }
    },
    [navigate],
  );

  const handleOpenTriggers = useCallback(async (workflow: Workflow) => {
    setTriggerWorkflow(workflow);
    setNewWebhookUrl(null);
    setTriggersLoading(true);
    try {
      setTriggers(
        await apiJson<WorkflowTrigger[]>(`/workflows/${workflow.id}/triggers`),
      );
    } catch (error: any) {
      setTriggers([]);
      Toast.error(error.message || "加载触发器失败");
    } finally {
      setTriggersLoading(false);
    }
  }, []);

  const createTrigger = useCallback(
    async (type: "webhook" | "schedule-daily" | "schedule-cron") => {
      if (!triggerWorkflow) return;
      setTriggerCreating(true);
      try {
        const body =
          type === "webhook"
            ? { name: "Webhook 触发器", type }
            : type === "schedule-daily"
              ? {
                  name: "每天 09:00 定时触发",
                  type: "schedule",
                  scheduleType: "daily",
                  dailyTime: "09:00",
                }
              : {
                  name: "每周一 09:00 Cron 触发",
                  type: "schedule",
                  scheduleType: "cron",
                  cronExpression: "0 9 * * 1",
                };
        const result = await apiJson<any>(
          `/workflows/${triggerWorkflow.id}/triggers`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        setTriggers((items) => [result.trigger, ...items]);
        if (result.webhookUrl) setNewWebhookUrl(result.webhookUrl);
        Toast.success(
          type === "webhook"
            ? "Webhook 已创建，请立即复制地址"
            : "定时触发器已创建",
        );
      } catch (error: any) {
        Toast.error(error.message || "创建触发器失败");
      } finally {
        setTriggerCreating(false);
      }
    },
    [triggerWorkflow],
  );

  const deleteTrigger = useCallback(
    async (triggerId: string) => {
      if (!triggerWorkflow) return;
      try {
        await apiJson(
          `/workflows/${triggerWorkflow.id}/triggers/${triggerId}`,
          {
            method: "DELETE",
          },
        );
        setTriggers((items) => items.filter((item) => item.id !== triggerId));
        Toast.success("触发器已删除");
      } catch (error: any) {
        Toast.error(error.message || "删除触发器失败");
      }
    },
    [triggerWorkflow],
  );

  const updateTrigger = useCallback(
    async (
      trigger: WorkflowTrigger,
      patch: Partial<Pick<WorkflowTrigger, "status" | "intervalMinutes">> & {
        scheduleType?: "interval" | "daily" | "cron";
        dailyTime?: string;
        cronExpression?: string;
        staticInputs?: Record<string, string | number | boolean>;
      },
    ) => {
      if (!triggerWorkflow) return;
      setTriggerUpdatingId(trigger.id);
      try {
        const updated = await apiJson<WorkflowTrigger>(
          `/workflows/${triggerWorkflow.id}/triggers/${trigger.id}`,
          { method: "PATCH", body: JSON.stringify(patch) },
        );
        setTriggers((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
        Toast.success(
          updated.status === "paused" ? "触发器已暂停" : "触发器已启用",
        );
      } catch (error: any) {
        Toast.error(error.message || "更新触发器失败");
      } finally {
        setTriggerUpdatingId(null);
      }
    },
    [triggerWorkflow],
  );

  const rotateWebhook = useCallback(
    async (trigger: WorkflowTrigger) => {
      if (!triggerWorkflow) return;
      setTriggerUpdatingId(trigger.id);
      try {
        const result = await apiJson<any>(
          `/workflows/${triggerWorkflow.id}/triggers/${trigger.id}/rotate-webhook`,
          { method: "POST" },
        );
        setTriggers((items) =>
          items.map((item) =>
            item.id === result.trigger.id ? result.trigger : item,
          ),
        );
        setNewWebhookUrl(result.webhookUrl || null);
        Toast.success("Webhook 地址已轮换，请立即复制新地址");
      } catch (error: any) {
        Toast.error(error.message || "轮换 Webhook 地址失败");
      } finally {
        setTriggerUpdatingId(null);
      }
    },
    [triggerWorkflow],
  );

  const handleCreate = useCallback(
    async (values: any) => {
      setCreating(true);
      try {
        const blankFlowgram = {
          nodes: [
            {
              id: "start_0",
              type: "start",
              meta: { position: { x: 80, y: 200 } },
              data: {
                title: "开始",
                outputs: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      default: "你好，请介绍一下你自己。",
                    },
                  },
                },
              },
            },
            {
              id: "llm_0",
              type: "llm",
              meta: { position: { x: 480, y: 200 } },
              data: {
                title: "大语言模型 1",
                inputsValues: {
                  modelName: { type: "constant", content: "glm-5.3-flash" },
                  temperature: { type: "constant", content: 0.7 },
                  systemPrompt: {
                    type: "template",
                    content:
                      "你是一个友好的 AI 助手，请用简洁的中文回答用户的问题。",
                  },
                  prompt: { type: "template", content: "{{start_0.query}}" },
                },
                inputs: {
                  type: "object",
                  required: ["modelName", "temperature", "prompt"],
                  properties: {
                    modelName: { type: "string" },
                    temperature: { type: "number" },
                    systemPrompt: {
                      type: "string",
                      extra: { formComponent: "prompt-editor" },
                    },
                    prompt: {
                      type: "string",
                      extra: { formComponent: "prompt-editor" },
                    },
                  },
                },
                outputs: {
                  type: "object",
                  properties: { result: { type: "string" } },
                },
              },
            },
            {
              id: "end_0",
              type: "end",
              meta: { position: { x: 880, y: 200 } },
              data: {
                title: "结束",
                inputsValues: {
                  result: { type: "ref", content: ["llm_0", "result"] },
                },
                inputs: {
                  type: "object",
                  properties: { result: { type: "string" } },
                },
              },
            },
          ],
          edges: [
            { sourceNodeID: "start_0", targetNodeID: "llm_0" },
            { sourceNodeID: "llm_0", targetNodeID: "end_0" },
          ],
        };

        const wf = await apiJson<Workflow>("/workflows", {
          method: "POST",
          body: JSON.stringify({
            name: values.name,
            description: values.description || "",
            flowgram: JSON.stringify(blankFlowgram),
          }),
        });

        Toast.success("创建成功");
        // 内嵌形态：告诉宿主「这里新建了一个工作流」，宿主据此刷新自己的列表 / 面包屑。
        notifyNavigation({
          kind: "workflow-created",
          workflowId: wf.id,
          name: values.name,
        });
        setCreateVisible(false);
        navigate(`/canvas/${wf.id}`);
      } catch (err: any) {
        Toast.error(err.message || "创建失败");
      } finally {
        setCreating(false);
      }
    },
    [navigate],
  );

  /** 导入工作流文件：本地先做结构自检，语义校验交给网关，避免两套规则漂移 */
  const handleImportFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // 选同一个文件第二次也要能触发 change
      event.target.value = "";
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        const fallbackName = file.name.replace(/\.(futureflow\.)?json$/i, "");
        const { data, error } = parseWorkflowFile(
          text,
          fallbackName || "导入的工作流",
        );
        if (!data) {
          Toast.error(error || "文件解析失败");
          return;
        }
        const created = await apiJson<Workflow>("/workflows/import", {
          method: "POST",
          body: JSON.stringify(data),
        });
        Toast.success(`已导入「${created.name}」`);
        void loadWorkflows(true);
        navigate(`/canvas/${created.id}`);
      } catch (error: any) {
        Toast.error(error?.message || "导入失败");
      } finally {
        setImporting(false);
      }
    },
    [loadWorkflows, navigate],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiJson<{ success: boolean }>(`/workflows/${id}`, {
          method: "DELETE",
        });
        Toast.success("已删除");
        await loadWorkflows(true);
      } catch (error: any) {
        Toast.error(error.message || "删除失败");
      }
    },
    [loadWorkflows],
  );

  const confirmDeleteWorkflow = useCallback(async () => {
    if (!deleteCandidate) return;
    setDeleting(true);
    try {
      await handleDelete(deleteCandidate.id);
      setDeleteCandidate(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteCandidate, handleDelete]);

  const handleDeleteDataset = useCallback(
    async (dataset: KnowledgeDataset) => {
      try {
        await apiJson(`/knowledge/datasets/${dataset.id}`, {
          method: "DELETE",
        });
        Toast.success("已删除知识库");
        await loadDatasets(true);
      } catch (error: any) {
        Toast.error(error.message || "删除知识库失败");
      }
    },
    [loadDatasets],
  );

  const handleDeleteFile = useCallback(
    async (file: StoredFile) => {
      try {
        await apiJson(`/files/${file.id}`, { method: "DELETE" });
        Toast.success("已删除文件");
        await loadFiles(true);
      } catch (error: any) {
        Toast.error(error.message || "删除文件失败");
      }
    },
    [loadFiles],
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        await apiJson<Workflow>(`/workflows/${id}/duplicate`, {
          method: "POST",
        });
        Toast.success("已复制");
        await loadWorkflows(true);
      } catch (error: any) {
        Toast.error(error.message || "复制失败");
      }
    },
    [loadWorkflows],
  );

  const handleRename = useCallback(
    async (kind: "workflow" | "dataset" | "file", id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        Toast.error("名称不能为空");
        return;
      }
      try {
        if (kind === "workflow") {
          await apiJson(`/workflows/${id}`, {
            method: "PUT",
            body: JSON.stringify({ name: trimmed }),
          });
          await loadWorkflows(true);
        } else if (kind === "dataset") {
          await apiJson(`/knowledge/datasets/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: trimmed }),
          });
          await loadDatasets(true);
        } else {
          await apiJson(`/files/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: trimmed }),
          });
          await loadFiles(true);
        }
        Toast.success("已重命名");
      } catch (error: any) {
        Toast.error(error.message || "重命名失败");
      }
    },
    [loadWorkflows, loadDatasets, loadFiles],
  );

  const confirmDeleteDataset = useCallback(async () => {
    if (!deleteDataset) return;
    await handleDeleteDataset(deleteDataset);
    setDeleteDataset(null);
  }, [deleteDataset, handleDeleteDataset]);

  const confirmDeleteFile = useCallback(async () => {
    if (!deleteFile) return;
    await handleDeleteFile(deleteFile);
    setDeleteFile(null);
  }, [deleteFile, handleDeleteFile]);

  const confirmRename = useCallback(async () => {
    if (!renameTarget) return;
    await handleRename(renameTarget.kind, renameTarget.id, renameName);
    setRenameTarget(null);
  }, [renameTarget, renameName, handleRename]);

  const handleCreateDataset = useCallback(
    async (name: string, description: string) => {
      try {
        await apiJson("/knowledge/datasets", {
          method: "POST",
          body: JSON.stringify({ name, description, indexing_technique: "economy" }),
        });
        Toast.success("知识库已创建");
        await loadDatasets(true);
      } catch (error: any) {
        Toast.error(error.message || "创建知识库失败");
      }
    },
    [loadDatasets],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      try {
        const body = new FormData();
        body.append("file", file);
        await apiJson("/files/upload", { method: "POST", body });
        Toast.success("文件已上传");
        await loadFiles(true);
      } catch (error: any) {
        Toast.error(error.message || "上传失败");
      }
    },
    [loadFiles],
  );

  const handleUploadDocument = useCallback(
    async (datasetId: string, name: string, text: string) => {
      try {
        await apiJson(`/knowledge/datasets/${datasetId}/documents`, {
          method: "POST",
          body: JSON.stringify({ name, text }),
        });
        Toast.success("文档已上传");
        await loadDatasets(true);
      } catch (error: any) {
        Toast.error(error.message || "文档上传失败");
      }
    },
    [loadDatasets],
  );


  const handleDuplicateDatasetFile = useCallback(
    async (kind: "dataset" | "file", id: string) => {
      try {
        if (kind === "file") {
          await apiJson(`/files/${id}/duplicate`, { method: "POST" });
          await loadFiles(true);
          Toast.success("已复制");
        }
      } catch (error: any) {
        Toast.error(error.message || "复制失败");
      }
    },
    [loadFiles],
  );

  const handlePublish = useCallback(
    async (id: string) => {
      setPublishingId(id);
      try {
        const result = await apiJson<{
          workflow: Workflow;
          message: string;
          dify: DifySyncResult;
        }>(`/workflows/${id}/publish`, { method: "POST" });
        if (result.dify?.status === "synced") {
          Toast.success(`${result.message}，已同步至版本专属 Dify 应用`);
        } else {
          Toast.warning(
            `${result.message}；${result.dify?.message || "尚未同步至 Dify，暂不能云端运行"}`,
          );
        }
        await loadWorkflows(true);
      } catch (error: any) {
        Toast.error(error.message || "发布失败");
      } finally {
        setPublishingId(null);
      }
    },
    [loadWorkflows],
  );

  const handleUnpublish = useCallback(
    async (id: string) => {
      setPublishingId(id);
      try {
        await apiJson(`/workflows/${id}/unpublish`, { method: "POST" });
        Toast.success("已取消发布，线上调用已停止");
        await loadWorkflows(true);
      } catch (error: any) {
        Toast.error(error.message || "取消发布失败");
      } finally {
        setPublishingId(null);
      }
    },
    [loadWorkflows],
  );

  const handleOpenRuns = useCallback(async (workflow: Workflow) => {
    setRunsWorkflow(workflow);
    setRunsLoading(true);
    try {
      const result = await apiJson<{ items: WorkflowRun[] }>(
        `/workflows/${workflow.id}/runs`,
      );
      setRuns(result.items);
    } catch (error: any) {
      setRuns([]);
      Toast.error(error.message || "加载运行记录失败");
    } finally {
      setRunsLoading(false);
    }
  }, []);

  // 运行历史中存在进行中的运行时自动轮询刷新（最多 2 分钟），结束后停止。
  useEffect(() => {
    if (!runsWorkflow) return;
    const active = runs.some(
      (run) => run.status === "running" || run.status === "pending",
    );
    if (!active) return;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 120_000 || runsWorkflow?.id === undefined) {
        window.clearInterval(timer);
        return;
      }
      try {
        const result = await apiJson<{ items: WorkflowRun[] }>(
          `/workflows/${runsWorkflow.id}/runs`,
        );
        setRuns(result.items);
        if (
          !result.items.some(
            (run) => run.status === "running" || run.status === "pending",
          )
        ) {
          window.clearInterval(timer);
        }
      } catch {
        // 轮询失败静默忽略，下一次 tick 重试。
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [runsWorkflow, runs]);

  const handleOpenVersions = useCallback(async (workflow: Workflow) => {
    setVersionsWorkflow(workflow);
    setVersionsLoading(true);
    try {
      setVersions(
        await apiJson<WorkflowVersion[]>(`/workflows/${workflow.id}/versions`),
      );
    } catch (error: any) {
      setVersions([]);
      Toast.error(error.message || "加载版本历史失败");
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  const restoreVersion = useCallback(
    async (version: WorkflowVersion) => {
      if (!versionsWorkflow) return;
      setRestoringVersion(version.version);
      try {
        await apiJson<Workflow>(
          `/workflows/${versionsWorkflow.id}/versions/${version.version}/restore`,
          { method: "POST" },
        );
        Toast.success(`已将 v${version.version} 恢复为草稿；请检查后重新发布`);
        await loadWorkflows(true);
      } catch (error: any) {
        Toast.error(error.message || "恢复版本失败");
      } finally {
        setRestoringVersion(null);
      }
    },
    [loadWorkflows, versionsWorkflow],
  );

  // 当前标签可见行：三类资源合并后按编辑时间倒序；搜索与发布状态筛选即时生效。
  const resourceRows = useMemo(() => {
    const rows: ResourceRow[] = [];
    if (activeTab === "all" || activeTab === "workflow") {
      workflows
        .filter((workflow) => {
          if (publishFilter === "published") return !!workflow.publishedVersion;
          if (publishFilter === "draft") return !workflow.publishedVersion;
          return true;
        })
        .forEach((workflow) =>
          rows.push({
            key: `workflow:${workflow.id}`,
            kind: "workflow",
            name: workflow.name || "未命名工作流",
            description: workflow.description || "暂无描述",
            editedAt: workflow.updatedAt || workflow.createdAt || null,
            workflow,
          }),
        );
    }
    if (activeTab === "all" || activeTab === "dataset") {
      datasets.forEach((dataset) =>
        rows.push({
          key: `dataset:${dataset.id}`,
          kind: "dataset",
          name: dataset.name || "未命名知识库",
          description: dataset.description || "暂无描述",
          editedAt: dataset.createdAt || dataset.updatedAt || null,
          dataset,
        }),
      );
    }
    if (activeTab === "all" || activeTab === "file") {
      files.forEach((file) =>
        rows.push({
          key: `file:${file.id}`,
          kind: "file",
          name: file.originalName || "未命名文件",
          description: formatFileSize(file.sizeBytes),
          editedAt: file.createdAt || null,
          file,
        }),
      );
    }

    const needle = keyword.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.description.toLowerCase().includes(needle),
        )
      : rows;
    return matched.sort(
      (left, right) =>
        editedTimeValue(right.editedAt) - editedTimeValue(left.editedAt),
    );
  }, [activeTab, publishFilter, keyword, workflows, datasets, files]);
  // ── 多选导出（key = kind:id，切 tab / 重载数据时清空） ──
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const toggleSelected = useCallback((key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedKeys(new Set());
  }, [activeTab]);

  const downloadBlob = useCallback((filename: string, data: unknown) => {
    const safe = (filename || "export")
      .replace(/[/:*?"<>|]+/g, "_")
      .slice(0, 100);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safe}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  const downloadFileBlob = useCallback(
    async (fileId: string, filename: string) => {
      const response = await apiFetch(`/files/${fileId}/download`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || "file";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    [],
  );

  const exportOne = useCallback(
    async (row: ResourceRow) => {
      if (row.kind === "workflow" && row.workflow) {
        const detail = await apiJson<
          Workflow & { flowgramJson?: Record<string, unknown> }
        >(`/workflows/${row.workflow.id}`);
        downloadBlob(
          `${row.name || "workflow"}.futureflow`,
          buildWorkflowExport(
            row.name || "workflow",
            detail.description || "",
            (detail.flowgramJson || {}) as Record<string, unknown>,
          ),
        );
        return;
      }
      if (row.kind === "dataset" && row.dataset) {
        const data = await apiJson<unknown>(
          `/knowledge/datasets/${row.dataset.id}/export`,
        );
        downloadBlob(`${row.name || "dataset"}.knowledge`, data);
        return;
      }
      if (row.kind === "file" && row.file) {
        await downloadFileBlob(row.file.id, row.file.originalName);
        return;
      }
    },
    [downloadBlob, downloadFileBlob],
  );

  const handleExportSelected = useCallback(async () => {
    if (selectedKeys.size === 0) return;
    setExporting(true);
    try {
      const rows = resourceRows.filter((row) => selectedKeys.has(row.key));
      for (const row of rows) {
        try {
          await exportOne(row);
        } catch (error: any) {
          Toast.error(
            `${row.name || "资源"} 导出失败：${error.message || "未知错误"}`,
          );
        }
      }
      if (rows.length > 0) Toast.success(`已导出 ${rows.length} 项`);
    } finally {
      setExporting(false);
    }
  }, [resourceRows, selectedKeys, exportOne]);

  // 前端分页只渲染当前页；删除/刷新后数据变少时把越界页码回收到最后一页
  const totalPages = Math.max(1, Math.ceil(resourceRows.length / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedRows = useMemo(
    () => resourceRows.slice((page - 1) * pageSize, page * pageSize),
    [resourceRows, page, pageSize],
  );

  const currentKinds: ResourceKind[] =
    activeTab === "all" ? ["workflow", "dataset", "file"] : [activeTab];
  const loadingByKind: Record<ResourceKind, boolean> = {
    workflow: workflowsLoading,
    dataset: datasetsLoading,
    file: filesLoading,
  };
  const errorByKind: Record<ResourceKind, string | null> = {
    workflow: workflowsError,
    dataset: datasetsError,
    file: filesError,
  };
  const currentLoading = currentKinds.some((kind) => loadingByKind[kind]);
  const currentError =
    currentKinds
      .map((kind) => errorByKind[kind])
      .find((message): message is string => !!message) || null;

  const reloadCurrentTab = useCallback(() => {
    if (activeTab === "all" || activeTab === "workflow")
      void loadWorkflows(true);
    if (activeTab === "all" || activeTab === "dataset") void loadDatasets(true);
    if (activeTab === "all" || activeTab === "file") void loadFiles(true);
  }, [activeTab, loadWorkflows, loadDatasets, loadFiles]);

  const emptyTitleByTab: Record<ResourceTab, string> = {
    all: "暂无资源",
    workflow: "暂无工作流",
    dataset: "暂无知识库",
    file: "暂无文件",
  };

  const emptyDescriptionByTab: Record<ResourceTab, string> = {
    all: "创建你的第一个工作流，或在个人中心添加知识库与文件。",
    workflow: "点击上方「创建工作流」，开始你的第一个 AI 工作流。",
    dataset: "知识库可在个人中心创建并管理。",
    file: "文件可在个人中心上传并管理。",
  };

  // 操作列：工作流沿用原有全部动作并收进 ... 菜单；知识库/文件为删除（带确认）+ 个人中心入口。
  const renderRowActions = (row: ResourceRow) => {
    if (row.kind === "workflow" && row.workflow) {
      const workflow = row.workflow;
      return (
        <Dropdown
          trigger="click"
          position="bottomRight"
          render={
            <Dropdown.Menu>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/canvas/${workflow.id}`);
                }}
              >
                打开画布
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  setRenameName(workflow.name || "");
                  setRenameTarget({
                    kind: "workflow",
                    id: workflow.id,
                    name: workflow.name || "",
                  });
                }}
              >
                重命名
              </Dropdown.Item>
              {workflow.publishedVersion ? (
                <Dropdown.Item
                  disabled={publishingId === workflow.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleUnpublish(workflow.id);
                  }}
                >
                  取消发布
                </Dropdown.Item>
              ) : (
                <Dropdown.Item
                  disabled={publishingId === workflow.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handlePublish(workflow.id);
                  }}
                >
                  发布
                </Dropdown.Item>
              )}
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void handleOpenRuns(workflow);
                }}
              >
                运行记录
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void handleOpenVersions(workflow);
                }}
              >
                版本历史
              </Dropdown.Item>
              {workflow.publishedVersion && (
                <Dropdown.Item
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleOpenTriggers(workflow);
                  }}
                >
                  触发器
                </Dropdown.Item>
              )}
              {workflow.publishedVersion && (
                <Dropdown.Item
                  onClick={(event) => {
                    event.stopPropagation();
                    setApiWorkflow(workflow);
                  }}
                >
                  API 调用
                </Dropdown.Item>
              )}
              {workflow.publishedVersion && (
                <Dropdown.Item
                  disabled={difyProvisioning}
                  onClick={(event) => {
                    event.stopPropagation();
                    void syncPublishedDify(workflow.id);
                  }}
                >
                  同步 Dify
                </Dropdown.Item>
              )}
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void exportOne(row);
                }}
              >
                导出
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDuplicate(workflow.id);
                }}
              >
                创建副本
              </Dropdown.Item>
              <Dropdown.Item
                type="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteCandidate(workflow);
                }}
              >
                删除
              </Dropdown.Item>
            </Dropdown.Menu>
          }
        >
          <RowIconButton
            type="button"
            aria-label="更多操作"
            onClick={(event) => event.stopPropagation()}
          >
            <IconMore />
          </RowIconButton>
        </Dropdown>
      );
    }
    if (row.kind === "dataset" && row.dataset) {
      const dataset = row.dataset;
      return (
        <Dropdown
          trigger="click"
          position="bottomRight"
          render={
            <Dropdown.Menu>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  setUploadDocName("");
                  setUploadDocText("");
                  setUploadDocTarget(dataset);
                }}
              >
                上传文档
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void exportOne(row);
                }}
              >
                导出
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  setRenameName(dataset.name || "");
                  setRenameTarget({
                    kind: "dataset",
                    id: dataset.id,
                    name: dataset.name || "",
                  });
                }}
              >
                重命名
              </Dropdown.Item>
              <Dropdown.Item
                type="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteDataset(dataset);
                }}
              >
                删除
              </Dropdown.Item>
            </Dropdown.Menu>
          }
        >
          <RowIconButton
            type="button"
            aria-label="更多操作"
            onClick={(event) => event.stopPropagation()}
          >
            <IconMore />
          </RowIconButton>
        </Dropdown>
      );
    }
    if (row.kind === "file" && row.file) {
      const file = row.file;
      return (
        <Dropdown
          trigger="click"
          position="bottomRight"
          render={
            <Dropdown.Menu>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void exportOne(row);
                }}
              >
                导出
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  setRenameName(file.originalName || "");
                  setRenameTarget({
                    kind: "file",
                    id: file.id,
                    name: file.originalName || "",
                  });
                }}
              >
                重命名
              </Dropdown.Item>
              <Dropdown.Item
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDuplicateDatasetFile("file", file.id);
                }}
              >
                创建副本
              </Dropdown.Item>
              <Dropdown.Item
                type="danger"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteFile(file);
                }}
              >
                删除
              </Dropdown.Item>
            </Dropdown.Menu>
          }
        >
          <RowIconButton
            type="button"
            aria-label="更多操作"
            onClick={(event) => event.stopPropagation()}
          >
            <IconMore />
          </RowIconButton>
        </Dropdown>
      );
    }
    return null;
  };

  return (
    <PageContainer className="page-shell">
      <header className="page-head page-fixed">
        <h1>工作流</h1>
        <p className="page-sub">在这里查看、编辑和发布你的 AI 工作流。</p>
        <div className="page-actions">
          {/* 内嵌形态：引擎凭证由宿主下发（凭证缝），受控引擎的授权也在宿主侧完成——
              管理入口不暴露给内嵌用户（管理员面收敛到宿主后台） */}
          {useFfEmbedStatus().state === "embedded" ? null : (
            <Button onClick={() => void openDifySettings()}>Dify 引擎</Button>
          )}
        </div>
      </header>

      {/* 标签行只保留资源类型切换，筛选与操作挪到下面同一行工具条 */}
      <TabRow className="page-fixed">
        <TabList role="tablist" aria-label="资源类型">
          {RESOURCE_TABS.map((tab) => (
            <TabButton
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              $active={activeTab === tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                // 分页状态各 tab 共用，切换后必须回到第一页
                setPage(1);
              }}
            >
              {tab.label}
            </TabButton>
          ))}
        </TabList>
      </TabRow>

      {/* 工具条：操作按钮在左，搜索与筛选在右 */}
      <div className="list-toolbar page-fixed">
        <div className="toolbar-actions">
          {/* 创建工作流 / 导入只属于工作流：知识库 / 文件 tab 不显示（避免误导性入口） */}
          {activeTab === "all" && (
            <Dropdown
              trigger="click"
              position="bottom"
              render={
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => setCreateVisible(true)}>
                    新建工作流
                  </Dropdown.Item>
                  <Dropdown.Item
                    onClick={() => {
                      setDatasetName("");
                      setDatasetCreateVisible(true);
                    }}
                  >
                    新建知识库
                  </Dropdown.Item>
                </Dropdown.Menu>
              }
            >
              <Button type="primary" theme="solid" icon={<IconPlus />}>
                创建
              </Button>
            </Dropdown>
          )}
          {activeTab === "workflow" && (
            <Button
              type="primary"
              theme="solid"
              icon={<IconPlus />}
              onClick={() => setCreateVisible(true)}
            >
              创建工作流
            </Button>
          )}
          {activeTab === "dataset" && (
            <Button
              type="primary"
              theme="solid"
              icon={<IconPlus />}
              onClick={() => {
                setDatasetName("");
                setDatasetCreateVisible(true);
              }}
            >
              新建知识库
            </Button>
          )}
          {activeTab === "file" && (
            <Button
              type="primary"
              theme="solid"
              icon={<IconUpload />}
              onClick={() => uploadFileInputRef.current?.click()}
            >
              上传文件
            </Button>
          )}
          {activeTab === "all" || activeTab === "workflow" ? (
            <Button
              theme="light"
              icon={<IconUpload />}
              loading={importing}
              onClick={() => importInputRef.current?.click()}
            >
              导入
            </Button>
          ) : null}
          <Button
            theme="light"
            icon={<IconDownload aria-hidden="true" />}
            disabled={selectedKeys.size === 0}
            loading={exporting}
            onClick={() => void handleExportSelected()}
          >
            导出{selectedKeys.size > 0 ? `（${selectedKeys.size}）` : ""}
          </Button>
          {/* 文件 tab 的隐藏上传 input（与工作流导入同款交互） */}
          <input
            ref={uploadFileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleUploadFile(file);
              event.target.value = "";
            }}
          />
          {/* 导入走隐藏的 file input：浏览器无法用脚本预填文件框，只能由用户选择 */}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => void handleImportFile(event)}
          />
        </div>
        <div className="toolbar-filters">
          {/* Semi 输入框默认 width:100%，会把同行的发布状态下拉挤到第二行；限定可伸缩宽度后两者保持同一行 */}
          <Input
            className="resource-search"
            style={{ flex: "0 1 240px", minWidth: 180 }}
            prefix={<IconSearch />}
            placeholder="搜索资源"
            value={keyword}
            onChange={(value) => {
              setKeyword(value);
              // 搜索条件变化后当前页码可能已越界，回到第 1 页
              setPage(1);
            }}
            showClear
          />
          {/* 发布状态筛选仅对「全部/工作流」有意义 */}
          {(activeTab === "all" || activeTab === "workflow") && (
            <Select
              value={publishFilter}
              onChange={(value) => {
                setPublishFilter(String(value) as PublishFilter);
                setPage(1);
              }}
              showArrow={false}
              style={{ width: 122 }}
              aria-label="发布状态筛选"
              optionList={[
                { value: "all", label: "全部" },
                { value: "published", label: "已发布" },
                { value: "draft", label: "草稿" },
              ]}
            />
          )}
        </div>
      </div>

      <ScrollArea className="page-scroll ff-scroll-fill">
        <ResourceCard>
          {/* 数据区是卡片里唯一的滚动容器：表头 sticky 吸附，分页条留在卡片底部不参与滚动 */}
          <ResourceTableScroll className="ff-table-scroll">
            {/* 空数据时不渲染表头，只留一块最小高度的 Empty，避免大片空白 */}
            {(currentLoading || resourceRows.length > 0) && (
              <TableHeader>
                <SelectCell>
                  <Checkbox
                    aria-label="全选本页"
                    checked={
                      pagedRows.length > 0 &&
                      pagedRows.every((row) => selectedKeys.has(row.key))
                    }
                    indeterminate={
                      selectedKeys.size > 0 &&
                      pagedRows.some((row) => selectedKeys.has(row.key)) &&
                      !pagedRows.every((row) => selectedKeys.has(row.key))
                    }
                    onChange={(event) => {
                      const checked = (event.target as HTMLInputElement).checked;
                      const next = new Set(selectedKeys);
                      for (const row of pagedRows) {
                        if (checked) next.add(row.key);
                        else next.delete(row.key);
                      }
                      setSelectedKeys(next);
                    }}
                  />
                </SelectCell>
                <span>资源</span>
                <span>类型</span>
                <span>编辑时间</span>
                <span>操作</span>
              </TableHeader>
            )}
            {currentLoading ? (
              <TableBodyState>
                <Spin size="large" />
              </TableBodyState>
            ) : resourceRows.length === 0 ? (
              <TableEmptyState>
                <div
                  style={{ display: "grid", justifyItems: "center", gap: 12 }}
                >
                  <Empty
                    title={
                      keyword.trim()
                        ? "没有匹配的资源"
                        : emptyTitleByTab[activeTab]
                    }
                    description={
                      keyword.trim()
                        ? "换个关键词试试。"
                        : currentError || emptyDescriptionByTab[activeTab]
                    }
                  />
                  {currentError && !keyword.trim() && (
                    <Button onClick={reloadCurrentTab}>重新加载</Button>
                  )}
                </div>
              </TableEmptyState>
            ) : (
              pagedRows.map((row) => (
                <ResourceRowItem
                  key={row.key}
                  $clickable={row.kind === "workflow"}
                  onClick={
                    row.kind === "workflow" && row.workflow
                      ? () => navigate(`/canvas/${row.workflow?.id}`)
                      : undefined
                  }
                >
                  <SelectCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`选择 ${row.name || row.key}`}
                      checked={selectedKeys.has(row.key)}
                      onChange={(event) =>
                        toggleSelected(
                          row.key,
                          (event.target as HTMLInputElement).checked,
                        )
                      }
                    />
                  </SelectCell>
                  <ResourceCell>
                    <RowIcon
                      $tint={cardTint(row.name || row.key)}
                      aria-hidden="true"
                    >
                      {(row.name || "?").trim().slice(0, 1).toUpperCase()}
                    </RowIcon>
                    <ResourceText>
                      <div className="resource-name">
                        <span className="resource-name-text" title={row.name}>
                          {row.name}
                        </span>
                        {row.kind === "workflow" &&
                          !!row.workflow?.publishedVersion && (
                            <span
                              className="resource-published"
                              title={`已发布 v${
                                formatVersionLabel(
                                  row.workflow.publishedVersion,
                                ) ?? row.workflow.publishedVersion
                              }`}
                              aria-label={`已发布`}
                            >
                              <IconTickCircle />
                            </span>
                          )}
                      </div>
                      <div className="resource-desc" title={row.description}>
                        {row.description}
                      </div>
                    </ResourceText>
                  </ResourceCell>
                  <TypeCell>{TYPE_LABELS[row.kind]}</TypeCell>
                  <TimeCell>{formatDateTime(row.editedAt)}</TimeCell>
                  <OpsCell>{renderRowActions(row)}</OpsCell>
                </ResourceRowItem>
              ))
            )}
          </ResourceTableScroll>

          {/* 分页固定在卡片底部：每页条数 → 共 N 页 → 页码，整体右对齐 */}
          {!currentLoading && resourceRows.length > 0 && (
            <PaginationBar>
              <span className="pagination-label">每页条数：</span>
              <Select
                value={pageSize}
                style={{ width: 88 }}
                aria-label="每页条数"
                optionList={PAGE_SIZE_OPTS.map((size) => ({
                  value: size,
                  label: String(size),
                }))}
                onChange={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
              />
              <span className="pagination-pages">共 {totalPages} 页</span>
              <Pagination
                currentPage={page}
                pageSize={pageSize}
                total={resourceRows.length}
                showSizeChanger={false}
                showTotal={false}
                onPageChange={(nextPage) => setPage(nextPage)}
              />
            </PaginationBar>
          )}
        </ResourceCard>
      </ScrollArea>

      <Modal
        title="创建工作流"
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        footer={null}
        style={{ borderRadius: 12 }}
      >
        <Form onSubmit={handleCreate}>
          <Form.Input
            field="name"
            label="工作流名称"
            placeholder="如：翻译助手"
            size="large"
            rules={[{ required: true, message: "请输入名称" }]}
          />
          <Form.TextArea
            field="description"
            label="描述"
            placeholder="可选，简要描述工作流用途"
            rows={2}
          />
          <Button
            type="primary"
            theme="solid"
            htmlType="submit"
            loading={creating}
            size="large"
            block
            style={{ marginTop: 16, borderRadius: 8, height: 44 }}
          >
            创建并进入编辑
          </Button>
        </Form>
      </Modal>

      <Modal
        title="确认删除此工作流？"
        visible={!!deleteCandidate}
        onCancel={() => setDeleteCandidate(null)}
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Button onClick={() => setDeleteCandidate(null)}>取消</Button>
            <Button
              type="danger"
              theme="solid"
              loading={deleting}
              onClick={() => void confirmDeleteWorkflow()}
            >
              删除
            </Button>
          </div>
        }
      >
        <Typography.Text type="tertiary">
          {deleteCandidate
            ? `「${deleteCandidate.name}」删除后无法恢复，发布版本与运行记录将一并移除。`
            : ""}
        </Typography.Text>
      </Modal>

      {/* 重命名（工作流 / 知识库 / 文件 三种资源共用） */}
      <Modal
        title={
          renameTarget?.kind === "workflow"
            ? "重命名工作流"
            : renameTarget?.kind === "dataset"
              ? "重命名知识库"
              : "重命名文件"
        }
        visible={!!renameTarget}
        onCancel={() => setRenameTarget(null)}
        onOk={() => void confirmRename()}
        okText="确定"
      >
        <Input
          value={renameName}
          maxLength={128}
          onChange={(value) => setRenameName(value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void confirmRename();
          }}
        />
      </Modal>

      {/* 知识库删除确认 */}
      <Modal
        title="确认删除此知识库？"
        visible={!!deleteDataset}
        onCancel={() => setDeleteDataset(null)}
        onOk={() => void confirmDeleteDataset()}
        okText="删除"
        type="warning"
      >
        <Typography.Text type="tertiary">
          {deleteDataset
            ? `「${deleteDataset.name}」及其文档将一并删除，无法恢复。`
            : ""}
        </Typography.Text>
      </Modal>

      {/* 文件删除确认 */}
      <Modal
        title="确认删除此文件？"
        visible={!!deleteFile}
        onCancel={() => setDeleteFile(null)}
        onOk={() => void confirmDeleteFile()}
        okText="删除"
        type="warning"
      >
        <Typography.Text type="tertiary">
          {deleteFile ? `「${deleteFile.originalName}」删除后无法恢复。` : ""}
        </Typography.Text>
      </Modal>

      {/* 新建知识库（原个人中心功能收敛到工作流页知识库 tab） */}
      <Modal
        title="新建知识库"
        visible={datasetCreateVisible}
        onCancel={() => setDatasetCreateVisible(false)}
        onOk={() => {
          if (!datasetName.trim()) {
            Toast.error("知识库名称不能为空");
            return;
          }
          void handleCreateDataset(datasetName.trim(), "");
          setDatasetCreateVisible(false);
          setDatasetName("");
        }}
        okText="创建"
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Input
            placeholder="知识库名称"
            value={datasetName}
            maxLength={40}
            onChange={(value) => setDatasetName(value)}
          />
        </div>
      </Modal>

      {/* 上传文档（按文本创建；文件型文档仍在个人中心管理） */}
      <Modal
        title={`上传文档到「${uploadDocTarget?.name || ""}」`}
        visible={!!uploadDocTarget}
        onCancel={() => setUploadDocTarget(null)}
        onOk={() => {
          if (!uploadDocName.trim() || !uploadDocText.trim()) {
            Toast.error("请填写文档名称与内容");
            return;
          }
          void handleUploadDocument(
            uploadDocTarget?.id || "",
            uploadDocName.trim(),
            uploadDocText,
          );
          setUploadDocTarget(null);
        }}
        okText="上传"
        width={560}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Input
            placeholder="文档名称"
            value={uploadDocName}
            maxLength={200}
            onChange={(value) => setUploadDocName(value)}
          />
          <TextArea
            placeholder="粘贴文档内容（纯文本）"
            value={uploadDocText}
            autosize={{ minRows: 6, maxRows: 16 }}
            onChange={(value: string) => setUploadDocText(value)}
          />
        </div>
      </Modal>

      <Modal
        title="工作流模板库"
        visible={templateVisible}
        onCancel={() => setTemplateVisible(false)}
        footer={null}
        style={{ width: 960, maxWidth: "calc(100vw - 32px)" }}
        bodyStyle={{ maxHeight: "calc(100vh - 150px)", overflowY: "auto" }}
      >
        {templatesLoading ? (
          <LoadingCenter>
            <Spin />
          </LoadingCenter>
        ) : templates.length === 0 ? (
          <Empty description="暂时没有可用模板" />
        ) : (
          <>
            <TemplateIntro>
              <div>
                <strong>从成熟结构开始</strong>
                <span>选择模板后会创建一份独立草稿，不会改动原模板。</span>
              </div>
              <TemplateCount>{templates.length} 个模板</TemplateCount>
            </TemplateIntro>
            <TemplateGrid>
              {templates.map((template) => (
                <TemplateCard key={template.id}>
                  <TemplateCardHeader>
                    <TemplateMark>
                      {template.tags[0]?.slice(0, 1) || "AI"}
                    </TemplateMark>
                    <TemplateTier>
                      {template.requiresDify ? "Dify 引擎" : "平台模板"}
                    </TemplateTier>
                  </TemplateCardHeader>
                  <Typography.Title heading={6} style={{ margin: 0 }}>
                    {template.name}
                  </Typography.Title>
                  <TemplateDescription>
                    {template.description}
                  </TemplateDescription>
                  <TemplateTags>
                    {template.tags.map((tag) => (
                      <Tag key={tag} size="small">
                        {tag}
                      </Tag>
                    ))}
                  </TemplateTags>
                  <Button
                    block
                    theme="solid"
                    type="primary"
                    loading={creating}
                    onClick={() => void handleCreateFromTemplate(template)}
                  >
                    使用此模板
                  </Button>
                </TemplateCard>
              ))}
            </TemplateGrid>
          </>
        )}
      </Modal>

      <Modal
        title="Dify 受控引擎"
        visible={difyVisible}
        onCancel={() => setDifyVisible(false)}
        footer={null}
        style={{ width: 640 }}
        bodyStyle={{
          maxHeight: "calc(100vh - 156px)",
          overflowY: "auto",
          paddingRight: 20,
        }}
      >
        {difyLoading ? (
          <LoadingCenter>
            <Spin />
          </LoadingCenter>
        ) : (
          <>
            <Typography.Text
              type="tertiary"
              style={{ display: "block", marginBottom: 12 }}
            >
              只需完成一次管理员授权。futureFlow
              会在每次发布时，为该工作流版本自动创建独立 Dify 应用、生成独立
              Service API
              Key，并将密钥加密保存；页面不会回显明文密钥。若服务端已配置
              LLM_API_KEY，还会在 Provider 缺失时安全同步到 Dify。
            </Typography.Text>
            {difyStatus && (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderRadius: 8,
                  background: "var(--ff-surface-muted)",
                }}
              >
                <Tag
                  color={difyStatus.connectionAuthorized ? "green" : "orange"}
                >
                  {difyStatus.connectionAuthorized ? "已授权" : "未授权"}
                </Tag>
                <Typography.Text style={{ marginLeft: 8 }}>
                  已管理 {difyStatus.managedWorkflowAppCount} 个独立发布版本
                </Typography.Text>
                {!difyStatus.encryptionReady && (
                  <Typography.Text
                    type="warning"
                    style={{ display: "block", marginTop: 8 }}
                  >
                    请先在 .env 设置至少 32 位且非示例值的
                    DIFY_KEY_ENCRYPTION_SECRET。
                  </Typography.Text>
                )}
                {difyStatus.modelProvider && (
                  <Typography.Text
                    type="tertiary"
                    style={{ display: "block", marginTop: 8 }}
                  >
                    模型 Provider：{difyStatus.modelProvider.message}
                  </Typography.Text>
                )}
              </div>
            )}
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--ff-border)",
              }}
            >
              <Typography.Text
                strong
                style={{ display: "block", marginBottom: 4 }}
              >
                零成本安全预检
              </Typography.Text>
              <Typography.Text
                type="tertiary"
                size="small"
                style={{ display: "block", marginBottom: 10 }}
              >
                仅检查 Dify
                服务可达性和本地加密配置；不会读取或保存管理员凭据，不会创建应用、Key
                或执行模型。
              </Typography.Text>
              <Button
                size="small"
                loading={difyPreflighting}
                onClick={() => void runDifyPreflight()}
              >
                运行安全预检
              </Button>
              {difyPreflight && (
                <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
                  {[
                    ["Dify API", difyPreflight.checks.apiHealth],
                    ["Console 接口", difyPreflight.checks.consoleEndpoint],
                    ["凭据加密", difyPreflight.checks.credentialEncryption],
                    ["已保存授权", difyPreflight.checks.storedAuthorization],
                    ["资源创建", difyPreflight.checks.provisioning],
                    ["模型执行", difyPreflight.checks.modelExecution],
                  ].map(([label, check]) => {
                    const item = check as DifyPreflightCheck;
                    const color =
                      item.state === "passed"
                        ? "green"
                        : item.state === "failed"
                          ? "red"
                          : "grey";
                    const stateLabel =
                      item.state === "passed"
                        ? "通过"
                        : item.state === "failed"
                          ? "需处理"
                          : "未执行";
                    return (
                      <div
                        key={label as string}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                        }}
                      >
                        <Tag size="small" color={color}>
                          {stateLabel}
                        </Tag>
                        <Typography.Text size="small" style={{ flex: 1 }}>
                          {label as string}：{item.message}
                          {item.version ? `（${item.version}）` : ""}
                        </Typography.Text>
                      </div>
                    );
                  })}
                  <Typography.Text type="tertiary" size="small">
                    下一步：{difyPreflight.nextStep}
                  </Typography.Text>
                </div>
              )}
            </div>
            <Form
              onSubmit={(values) => {
                void (difySubmitMode.current === "validate"
                  ? validateDifyAuthorization(values)
                  : bootstrapDify(values));
              }}
            >
              <Form.Input
                field="consoleBase"
                label="Dify Console 地址"
                initValue="http://localhost:5001/console/api"
                placeholder="http://localhost:5001/console/api"
              />
              <Form.Input
                field="email"
                label="Dify 管理员邮箱（可选）"
                placeholder="与密码二选一，或直接使用 Token"
              />
              <Form.Input
                field="password"
                mode="password"
                label="Dify 管理员密码（可选）"
                placeholder="仅用于换取令牌，不会保存"
              />
              <Form.Input
                field="consoleToken"
                mode="password"
                label="Dify Console Token（可选）"
                placeholder="邮箱密码或 Token 至少填写一种"
              />
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <Button
                  htmlType="submit"
                  loading={difyProvisioning}
                  style={{ flex: 1, borderRadius: 8 }}
                  onClick={() => {
                    difySubmitMode.current = "validate";
                  }}
                >
                  验证管理员授权（不保存）
                </Button>
                <Button
                  type="primary"
                  theme="solid"
                  htmlType="submit"
                  loading={difyProvisioning}
                  style={{ flex: 1, borderRadius: 8 }}
                  onClick={() => {
                    difySubmitMode.current = "save";
                  }}
                >
                  保存授权并启用自动建应用 / Key
                </Button>
              </div>
              <Typography.Text
                type="tertiary"
                size="small"
                style={{ display: "block", marginTop: 10 }}
              >
                保存授权只启用后续发布的资源自动创建；若首次同步模型
                Provider，Dify
                会发送一次凭据验证请求，可能产生极少量模型用量。真实工作流仍需由你显式运行。
              </Typography.Text>
            </Form>
          </>
        )}
      </Modal>

      <Modal
        title={`${apiWorkflow?.name || ""} · API 调用`}
        visible={!!apiWorkflow}
        onCancel={() => setApiWorkflow(null)}
        footer={
          <Button
            type="primary"
            theme="solid"
            onClick={() => setApiWorkflow(null)}
          >
            完成
          </Button>
        }
      >
        <Typography.Text
          type="tertiary"
          style={{ display: "block", marginBottom: 12 }}
        >
          已发布版本可通过平台 API Key 调用；编辑草稿不会影响当前线上版本。
        </Typography.Text>
        <CodeBlock>{`curl -X POST ${GATEWAY_URL}/workflows/${
          apiWorkflow?.id || "<WORKFLOW_ID>"
        }/execute \\
  -H "Authorization: Bearer ff-xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"inputs":{"query":"你好"}}'`}</CodeBlock>
        <Typography.Text
          type="tertiary"
          style={{ display: "block", marginTop: 12 }}
        >
          返回为 SSE 流。请在「个人中心」创建或管理 API Key。
        </Typography.Text>
      </Modal>

      <Modal
        title={`${runsWorkflow?.name || ""} · 运行记录`}
        visible={!!runsWorkflow}
        onCancel={() => setRunsWorkflow(null)}
        footer={<Button onClick={() => setRunsWorkflow(null)}>关闭</Button>}
        style={{ width: 680 }}
      >
        {runsLoading ? (
          <RunLoading>
            <Spin />
          </RunLoading>
        ) : runs.length === 0 ? (
          <Empty description="暂无已发布 API 调用记录" />
        ) : (
          <RunHistory>
            {runs.map((run) => (
              <RunRow key={run.id}>
                <RunHeader>
                  <Tag
                    size="small"
                    color={
                      run.status === "succeeded"
                        ? "green"
                        : run.status === "failed"
                          ? "red"
                          : run.status === "running"
                            ? "blue"
                            : "grey"
                    }
                  >
                    {
                      {
                        pending: "等待中",
                        running: "运行中",
                        succeeded: "成功",
                        failed: "失败",
                        cancelled: "已取消",
                      }[run.status]
                    }
                  </Tag>
                  <Typography.Text type="tertiary" size="small">
                    {new Date(run.createdAt).toLocaleString("zh-CN")}
                  </Typography.Text>
                </RunHeader>
                <RunMeta>
                  {run.source && (
                    <Tag size="small" style={{ marginRight: 6 }}>
                      {RUN_SOURCE_LABELS[run.source] || run.source}
                    </Tag>
                  )}
                  {run.totalTokens} 令牌 · {run.totalSteps} 步 ·{" "}
                  {run.elapsedTime?.toFixed(2) || "0.00"} 秒 · ¥
                  {Number(run.actualCost || 0).toFixed(4)}
                </RunMeta>
                {run.errorMessage && <RunError>{run.errorMessage}</RunError>}
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
      <Modal
        title={`${versionsWorkflow?.name || ""} · 发布版本历史`}
        visible={!!versionsWorkflow}
        onCancel={() => setVersionsWorkflow(null)}
        footer={<Button onClick={() => setVersionsWorkflow(null)}>关闭</Button>}
        style={{ width: 680 }}
      >
        <Typography.Text
          type="tertiary"
          style={{ display: "block", marginBottom: 12 }}
        >
          恢复只会写入当前草稿，不会自动替换线上已发布版本；确认后请在画布检查并重新发布。
        </Typography.Text>
        {versionsLoading ? (
          <RunLoading>
            <Spin />
          </RunLoading>
        ) : versions.length === 0 ? (
          <Empty description="暂无发布版本" />
        ) : (
          <RunHistory>
            {versions.map((version) => (
              <RunRow key={version.id}>
                <RunHeader>
                  <Typography.Text strong>
                    v{version.version} · {version.name}
                  </Typography.Text>
                  <Typography.Text type="tertiary" size="small">
                    {new Date(version.publishedAt).toLocaleString("zh-CN")}
                  </Typography.Text>
                </RunHeader>
                <RunMeta>{version.description || "无描述"}</RunMeta>
                <Popconfirm
                  title={`恢复 v${version.version} 为当前草稿？`}
                  content="线上已发布版本不会自动改变。"
                  okText="恢复草稿"
                  cancelText="取消"
                  onConfirm={() => void restoreVersion(version)}
                >
                  <Button
                    size="small"
                    style={{ marginTop: 8 }}
                    loading={restoringVersion === version.version}
                  >
                    恢复为草稿
                  </Button>
                </Popconfirm>
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
      <Modal
        title={`${triggerWorkflow?.name || ""} · 触发器`}
        visible={!!triggerWorkflow}
        onCancel={() => setTriggerWorkflow(null)}
        footer={<Button onClick={() => setTriggerWorkflow(null)}>关闭</Button>}
        style={{ width: 680 }}
      >
        <Typography.Text
          type="tertiary"
          style={{ display: "block", marginBottom: 12 }}
        >
          Webhook 适合外部系统事件；定时触发器按固定分钟间隔执行已发布快照。
        </Typography.Text>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <Button
            theme="solid"
            type="primary"
            loading={triggerCreating}
            onClick={() => void createTrigger("webhook")}
          >
            创建 Webhook
          </Button>
          <Button
            loading={triggerCreating}
            onClick={() => void createTrigger("schedule-daily")}
          >
            创建每日定时（09:00）
          </Button>
          <Button
            loading={triggerCreating}
            onClick={() => void createTrigger("schedule-cron")}
          >
            创建 Cron 调度
          </Button>
        </div>
        {newWebhookUrl && (
          <>
            <Typography.Text
              type="warning"
              style={{ display: "block", marginBottom: 6 }}
            >
              请立即保存此地址；轮换后旧地址立即失效。
            </Typography.Text>
            <CodeBlock>{newWebhookUrl}</CodeBlock>
          </>
        )}
        {triggersLoading ? (
          <RunLoading>
            <Spin />
          </RunLoading>
        ) : triggers.length === 0 ? (
          <Empty description="尚未配置触发器" />
        ) : (
          <RunHistory>
            {triggers.map((trigger) => (
              <RunRow key={trigger.id}>
                <RunHeader>
                  <Typography.Text strong>{trigger.name}</Typography.Text>
                  <Tag
                    size="small"
                    color={trigger.type === "webhook" ? "blue" : "orange"}
                  >
                    {trigger.type === "webhook" ? "Webhook" : "定时"}
                  </Tag>
                </RunHeader>
                <RunMeta>
                  {trigger.type === "schedule" ? (
                    trigger.scheduleType === "cron" ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>Cron</span>
                        <input
                          defaultValue={trigger.cronExpression ?? ""}
                          disabled={trigger.status !== "active"}
                          aria-label="修改 Cron 表达式"
                          placeholder="分 时 日 月 周"
                          style={{
                            width: 120,
                            border: "1px solid var(--ff-border-strong)",
                            borderRadius: 4,
                            padding: "1px 4px",
                            fontSize: 12,
                            fontFamily: "monospace",
                          }}
                          onChange={(event) =>
                            setCronEdits((prev) => ({
                              ...prev,
                              [trigger.id]: event.target.value,
                            }))
                          }
                        />
                        <span>
                          · 下次{" "}
                          {trigger.nextRunAt
                            ? new Date(trigger.nextRunAt).toLocaleString(
                                "zh-CN",
                              )
                            : "-"}
                        </span>
                        {cronEdits[trigger.id] &&
                          cronEdits[trigger.id] !== trigger.cronExpression && (
                            <Button
                              size="small"
                              theme="borderless"
                              loading={triggerUpdatingId === trigger.id}
                              onClick={() => {
                                const expression = cronEdits[trigger.id].trim();
                                if (expression.split(/\s+/).length !== 5) {
                                  Toast.error(
                                    "Cron 表达式必须是 5 个字段（分 时 日 月 周）",
                                  );
                                  return;
                                }
                                void updateTrigger(trigger, {
                                  scheduleType: "cron",
                                  cronExpression: expression,
                                });
                              }}
                            >
                              保存表达式
                            </Button>
                          )}
                      </span>
                    ) : trigger.scheduleType === "daily" &&
                      trigger.dailyTime ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>每天</span>
                        <input
                          type="time"
                          defaultValue={trigger.dailyTime}
                          disabled={trigger.status !== "active"}
                          aria-label="修改每日执行时间"
                          style={{
                            border: "1px solid var(--ff-border-strong)",
                            borderRadius: 4,
                            padding: "1px 4px",
                            fontSize: 12,
                          }}
                          onChange={(event) =>
                            setDailyTimeEdits((prev) => ({
                              ...prev,
                              [trigger.id]: event.target.value,
                            }))
                          }
                        />
                        <span>
                          · 下次{" "}
                          {trigger.nextRunAt
                            ? new Date(trigger.nextRunAt).toLocaleString(
                                "zh-CN",
                              )
                            : "-"}
                        </span>
                        {dailyTimeEdits[trigger.id] &&
                          dailyTimeEdits[trigger.id] !== trigger.dailyTime && (
                            <Button
                              size="small"
                              theme="borderless"
                              loading={triggerUpdatingId === trigger.id}
                              onClick={() =>
                                void updateTrigger(trigger, {
                                  scheduleType: "daily",
                                  dailyTime: dailyTimeEdits[trigger.id],
                                })
                              }
                            >
                              保存时间
                            </Button>
                          )}
                      </span>
                    ) : (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span>每</span>
                        <input
                          type="number"
                          min={1}
                          max={43200}
                          defaultValue={trigger.intervalMinutes ?? 60}
                          disabled={trigger.status !== "active"}
                          aria-label="修改执行间隔（分钟）"
                          style={{
                            width: 64,
                            border: "1px solid var(--ff-border-strong)",
                            borderRadius: 4,
                            padding: "1px 4px",
                            fontSize: 12,
                          }}
                          onChange={(event) =>
                            setIntervalEdits((prev) => ({
                              ...prev,
                              [trigger.id]: event.target.value,
                            }))
                          }
                        />
                        <span>
                          分钟 · 下次{" "}
                          {trigger.nextRunAt
                            ? new Date(trigger.nextRunAt).toLocaleString(
                                "zh-CN",
                              )
                            : "-"}
                        </span>
                        {intervalEdits[trigger.id] &&
                          String(trigger.intervalMinutes) !==
                            intervalEdits[trigger.id] && (
                            <Button
                              size="small"
                              theme="borderless"
                              loading={triggerUpdatingId === trigger.id}
                              onClick={() => {
                                const minutes = Number(
                                  intervalEdits[trigger.id],
                                );
                                if (
                                  !Number.isInteger(minutes) ||
                                  minutes < 1 ||
                                  minutes > 43200
                                ) {
                                  Toast.error(
                                    "执行间隔必须是 1 到 43200 之间的整数分钟",
                                  );
                                  return;
                                }
                                void updateTrigger(trigger, {
                                  intervalMinutes: minutes,
                                });
                              }}
                            >
                              保存间隔
                            </Button>
                          )}
                      </span>
                    )
                  ) : (
                    "使用专属安全地址调用"
                  )}
                  {trigger.lastRunStatus
                    ? ` · 上次 ${trigger.lastRunStatus === "succeeded" ? "成功" : "失败"}`
                    : ""}
                  {/* 连续失败次数原先已由接口返回、但界面不展示，导致「一直失败」的
                      定时任务在页面上看只是「上次失败」，无法察觉严重程度。 */}
                  {trigger.failureCount && trigger.failureCount > 0
                    ? ` · 连续失败 ${trigger.failureCount} 次`
                    : ""}
                </RunMeta>
                <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                  <Button
                    theme="borderless"
                    size="small"
                    loading={triggerUpdatingId === trigger.id}
                    onClick={() =>
                      void updateTrigger(trigger, {
                        status:
                          trigger.status === "active" ? "paused" : "active",
                      })
                    }
                  >
                    {trigger.status === "active" ? "暂停" : "启用"}
                  </Button>
                  {trigger.staticInputs &&
                    Object.keys(trigger.staticInputs).length > 0 && (
                      <Button
                        theme="borderless"
                        size="small"
                        onClick={() =>
                          setStaticInputsEdit({
                            trigger,
                            values: { ...trigger.staticInputs },
                          })
                        }
                      >
                        编辑入参
                      </Button>
                    )}
                  {trigger.type === "webhook" && (
                    <Button
                      theme="borderless"
                      size="small"
                      loading={triggerUpdatingId === trigger.id}
                      onClick={() => void rotateWebhook(trigger)}
                    >
                      轮换地址
                    </Button>
                  )}
                  <Button
                    theme="borderless"
                    type="danger"
                    size="small"
                    onClick={() => void deleteTrigger(trigger.id)}
                  >
                    删除
                  </Button>
                </div>
              </RunRow>
            ))}
          </RunHistory>
        )}
      </Modal>
      <Modal
        title={`编辑静态入参 · ${staticInputsEdit?.trigger.name || ""}`}
        visible={!!staticInputsEdit}
        onCancel={() => setStaticInputsEdit(null)}
        footer={null}
        style={{ width: 560 }}
      >
        {staticInputsEdit && (
          <Form
            key={staticInputsEdit.trigger.id}
            onSubmit={(values: Record<string, any>) => {
              void (async () => {
                await updateTrigger(staticInputsEdit.trigger, {
                  staticInputs: values,
                });
                Toast.success("静态入参已更新");
                setTriggers((items) =>
                  items.map((item) =>
                    item.id === staticInputsEdit.trigger.id
                      ? { ...item, staticInputs: values }
                      : item,
                  ),
                );
                setStaticInputsEdit(null);
              })();
            }}
            initValues={staticInputsEdit.values}
          >
            {Object.entries(staticInputsEdit.values).map(([name]) => (
              <Form.Input key={name} field={name} label={name} />
            ))}
            {Object.keys(staticInputsEdit.values).length === 0 && (
              <Typography.Text type="tertiary">
                此触发器没有静态入参。
              </Typography.Text>
            )}
            <div className="modal-actions">
              <Button onClick={() => setStaticInputsEdit(null)}>取消</Button>
              <Button type="primary" theme="solid" htmlType="submit">
                保存
              </Button>
            </div>
          </Form>
        )}
      </Modal>
    </PageContainer>
  );
};

const PageContainer = styled.div`
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  padding: 34px 40px 0;

  @media (max-width: 720px) {
    height: auto;
    padding: 24px 16px 0;
  }
`;

/** 滚动区：滚动收进表格卡片（见 .ff-scroll-fill），本层只负责布局，不再出现内外两条滚动条 */
const ScrollArea = styled.div`
  padding-bottom: 24px;

  @media (max-width: 720px) {
    padding-bottom: 32px;
  }
`;

/** 分页条：固定在卡片底部不随数据滚动；每页条数 → 共 N 页 → 页码，整体右对齐 */
const PaginationBar = styled.div`
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid var(--ff-border);
  background: var(--ff-surface);

  .pagination-label,
  .pagination-pages {
    color: var(--ff-muted);
    font-size: 13px;
  }
`;

const TabRow = styled.div`
  display: flex;
  align-items: center;
  min-height: 48px;
  border-bottom: 1px solid var(--ff-border);
`;

const TabList = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 26px;
`;

const TabButton = styled.button<{ $active: boolean }>`
  position: relative;
  height: 48px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: ${(props) => (props.$active ? "var(--ff-primary)" : "var(--ff-text-secondary)")};
  cursor: pointer;
  font-size: 15px;
  font-weight: ${(props) => (props.$active ? 600 : 500)};
  white-space: nowrap;
  transition: color 120ms ease;

  &::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 2px;
    border-radius: 2px;
    background: ${(props) => (props.$active ? "var(--ff-primary)" : "transparent")};
    content: '';
  }

  &:hover {
    color: var(--ff-primary);
  }
`;

/** 本页专用工具条：筛选/搜索/操作同一行左对齐 */
const ResourceCard = styled.section`
  /* 卡片撑满滚动区，数据区自己滚、分页条固定在卡片底部 */
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
`;

/** 数据区：卡片里唯一的滚动容器，表头用 sticky 吸附在这里的顶部 */
const ResourceTableScroll = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
`;

/** 表格列：资源自适应（至少 40%），类型/编辑时间/操作固定宽度 */
const TABLE_GRID = "36px minmax(38%, 1fr) 130px 170px 90px";

const SelectCell = styled.div`
  display: flex;
  align-items: center;
  /* 靠列首左对齐（用户反馈：选择框往左移） */
  justify-content: flex-start;
`;

const TableHeader = styled.div`
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  align-items: center;
  height: 44px;
  grid-template-columns: ${TABLE_GRID};
  padding: 0 18px;
  border-bottom: 1px solid var(--ff-border);
  background: var(--ff-surface-muted);
  color: var(--ff-muted);
  font-size: 12px;
  font-weight: 600;
  /* 类型/编辑时间/操作列标题居中；资源列与数据行一致靠左 */
  text-align: center;

  & > span:first-child {
    text-align: left;
  }

  @media (max-width: 720px) {
    grid-template-columns: 28px minmax(0, 1fr) 100px 120px 72px;
    padding: 0 14px;
  }
`;

const TableBodyState = styled.div`
  display: grid;
  min-height: 240px;
  place-items: center;
  padding: 24px;
  border-top: 1px solid var(--ff-border);
`;

/** 空状态：不渲染表头时给一个克制的最小高度 */
const TableEmptyState = styled.div`
  display: grid;
  min-height: 160px;
  place-items: center;
  padding: 24px;
`;

const ResourceRowItem = styled.div<{ $clickable?: boolean }>`
  display: grid;
  min-height: 72px;
  align-items: center;
  grid-template-columns: ${TABLE_GRID};
  padding: 12px 18px;
  border-top: 1px solid var(--ff-border);
  background: var(--ff-surface);
  cursor: ${(props) => (props.$clickable ? "pointer" : "default")};
  transition: background-color 120ms ease;

  &:hover {
    background: ${(props) => (props.$clickable ? "var(--ff-primary-soft)" : "var(--ff-surface)")};
  }

  @media (max-width: 720px) {
    grid-template-columns: 28px minmax(0, 1fr) 100px 120px 72px;
    padding: 12px 14px;
  }
`;

/** 资源列：色块 + 名称/描述整体靠左对齐（用户要求首列左对齐，其余列居中） */
const ResourceCell = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
`;

const RowIcon = styled.div<{ $tint: { bg: string; fg: string } }>`
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  border-radius: var(--ff-radius);
  background: ${(props) => props.$tint.bg};
  color: ${(props) => props.$tint.fg};
  font-size: 16px;
  font-weight: 600;
`;

const ResourceText = styled.div`
  /* 占满色块右侧空间，名称/描述超长时按列宽省略号截断 */
  flex: 1 1 auto;
  min-width: 0;

  .resource-name {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
  }

  .resource-name-text {
    overflow: hidden;
    color: var(--ff-text);
    font-size: 15px;
    font-weight: 600;
    line-height: 22px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-published {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--ff-success);
    font-size: 15px;
    line-height: 0;
  }

  .resource-desc {
    overflow: hidden;
    margin-top: 2px;
    color: var(--ff-muted);
    font-size: 13px;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const TypeCell = styled.div`
  color: var(--ff-text-secondary);
  font-size: 13px;
  text-align: center;
`;

const TimeCell = styled.div`
  color: var(--ff-text-secondary);
  font-size: 13px;
  text-align: center;
  white-space: nowrap;
`;

const OpsCell = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
`;

const RowIconButton = styled.button<{ $danger?: boolean }>`
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--ff-radius);
  background: transparent;
  color: var(--ff-subtle);
  cursor: pointer;
  font-size: 15px;
  transition: background-color 120ms ease, color 120ms ease;

  &:hover {
    background: ${(props) => (props.$danger ? "var(--ff-danger-soft)" : "var(--ff-surface-muted)")};
    color: ${(props) => (props.$danger ? "var(--ff-danger)" : "var(--ff-text)")};
  }
`;

const LoadingCenter = styled.div`
  display: grid;
  min-height: 300px;
  place-items: center;
`;

/** 资源行首字母底色：按名称稳定取色，让同一列表里的条目彼此可辨 */
const CARD_TINTS = [
  { bg: "#eef4ff", fg: "#2563eb" },
  { bg: "#ecfdf3", fg: "#16803c" },
  { bg: "#fff6e8", fg: "#b54708" },
  { bg: "#e9f7fa", fg: "#0e7490" },
  { bg: "#f1f3f7", fg: "#4e5969" },
];

const cardTint = (seed: string) => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return CARD_TINTS[hash % CARD_TINTS.length];
};

const CodeBlock = styled.pre`
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  border: 1px solid #1e293b;
  border-radius: var(--ff-radius);
  background: #0f172a;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
`;

const TemplateGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 840px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 580px) {
    grid-template-columns: 1fr;
  }
`;

const TemplateCard = styled.article`
  display: flex;
  min-height: 222px;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;

  &:hover {
    border-color: var(--ff-primary-border);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
    transform: translateY(-2px);
  }

  .semi-button {
    margin-top: auto;
  }
`;

const TemplateIntro = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--ff-primary-border);
  border-radius: var(--ff-radius);
  background: #f8fbff;

  div {
    display: grid;
    gap: 3px;
  }

  strong {
    color: var(--ff-text);
    font-size: 14px;
  }

  span {
    color: var(--ff-muted);
    font-size: 12px;
    line-height: 18px;
  }
`;

const TemplateCount = styled.span`
  flex: 0 0 auto;
  color: var(--ff-primary);
  font-size: 12px;
  font-weight: 700;
`;

const TemplateCardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const TemplateMark = styled.div`
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--ff-primary-border);
  border-radius: var(--ff-radius);
  background: var(--ff-surface-muted);
  color: var(--ff-primary-hover);
  font-size: 14px;
  font-weight: 700;
`;

const TemplateTier = styled.span`
  color: var(--ff-muted);
  font-size: 11px;
  font-weight: 600;
`;

const TemplateDescription = styled.div`
  display: -webkit-box;
  min-height: 40px;
  overflow: hidden;
  color: var(--ff-muted);
  font-size: 13px;
  line-height: 20px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
`;

const TemplateTags = styled.div`
  display: flex;
  min-height: 22px;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
`;

const RunLoading = styled.div`
  display: grid;
  min-height: 220px;
  place-items: center;
`;

const RunHistory = styled.div`
  display: flex;
  max-height: 440px;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
`;

const RunRow = styled.div`
  padding: 14px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: var(--ff-surface);
  transition: border-color 0.15s ease;

  &:hover {
    border-color: var(--ff-border-strong);
  }
`;

const RunHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`;

const RunMeta = styled.div`
  margin-top: 8px;
  color: var(--ff-muted);
  font-size: 12px;
  line-height: 18px;
`;

const RunError = styled.div`
  margin-top: 8px;
  color: var(--ff-danger);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
`;
