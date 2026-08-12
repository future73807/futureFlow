import JSZip from 'jszip';

export interface ResultArchivePayload {
  workflowName?: string;
  status: string;
  inputs?: Record<string, unknown>;
  text?: string;
  outputs?: Record<string, unknown>;
  nodes?: unknown[];
  statistics?: Record<string, unknown>;
  error?: string;
  /**
   * 开始节点中实际流入认证位置的字段名。字段可以叫 foo/query 等普通名称，
   * 因此不能只依赖 apiKey/token 这类命名规则判断。
   */
  sensitiveInputKeys?: string[];
}

const PREFERRED_TEXT_KEYS = ['text', 'result', 'output', 'answer', 'content', 'message'];

/**
 * 从结束节点输出中提取最适合单独保存的文本。优先使用常见文本字段，
 * 再回退到任意非空字符串；图片/视频 URL 仍完整保留在 JSON 文件中。
 */
export function extractTextOutput(outputs?: Record<string, unknown>): string | undefined {
  if (!outputs) return undefined;
  const visited = new WeakSet<object>();

  const findText = (value: unknown, preferredOnly: boolean, depth = 0): string | undefined => {
    if (typeof value === 'string') {
      const text = value.trim();
      return text || undefined;
    }
    if (!value || typeof value !== 'object' || depth > 8 || visited.has(value)) {
      return undefined;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const text = findText(item, preferredOnly, depth + 1);
        if (text) return text;
      }
      return undefined;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const candidates = preferredOnly
      ? entries.filter(([key]) => PREFERRED_TEXT_KEYS.includes(key.toLowerCase()))
      : entries;
    for (const [, child] of candidates) {
      const text = findText(child, preferredOnly, depth + 1);
      if (text) return text;
    }
    return undefined;
  };

  return findText(outputs, true) || (() => {
    // 首轮遍历使用了 visited；回退遍历需要独立访问集合。
    const fallbackVisited = new WeakSet<object>();
    const findFallback = (value: unknown, depth = 0): string | undefined => {
      if (typeof value === 'string') return value.trim() || undefined;
      if (!value || typeof value !== 'object' || depth > 8 || fallbackVisited.has(value)) {
        return undefined;
      }
      fallbackVisited.add(value);
      for (const child of Array.isArray(value)
        ? value
        : Object.values(value as Record<string, unknown>)) {
        const text = findFallback(child, depth + 1);
        if (text) return text;
      }
      return undefined;
    };
    return findFallback(outputs);
  })();
}

const safeFileName = (value: string) =>
  value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').slice(0, 80) || '工作流结果';

const SENSITIVE_KEY_PATTERN = /api.?key|authorization|cookie|credential|password|secret|token/i;

const collectSensitiveTextValues = (
  value: unknown,
  key = '',
  values = new Set<string>(),
): Set<string> => {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    const collectScalar = (candidate: unknown) => {
      if (typeof candidate !== 'string' || candidate.length < 4) return;
      values.add(candidate);
      const encoded = encodeURIComponent(candidate);
      if (encoded !== candidate) values.add(encoded);
    };
    if (Array.isArray(value)) value.forEach(collectScalar);
    else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(collectScalar);
    } else collectScalar(value);
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSensitiveTextValues(item, '', values));
  } else if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      collectSensitiveTextValues(child, childKey, values);
    });
  }
  return values;
};

const collectScalarTextValues = (value: unknown, values: Set<string>) => {
  if (typeof value === 'string') {
    if (value.length < 4) return;
    values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) values.add(encoded);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectScalarTextValues(item, values));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.values(value as Record<string, unknown>)
    .forEach((item) => collectScalarTextValues(item, values));
};

const redactKnownText = (value: string, sensitiveValues: string[]) =>
  sensitiveValues.reduce(
    (safe, secret) => safe.split(secret).join('[已隐藏]'),
    value,
  );

const redactSensitiveValues = (
  value: unknown,
  key = '',
  sensitiveValues: string[] = [],
): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[已隐藏]';
  if (typeof value === 'string') return redactKnownText(value, sensitiveValues);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, '', sensitiveValues));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactSensitiveValues(child, childKey, sensitiveValues),
    ]),
  );
};

export function createResultArchive(
  payload: ResultArchivePayload,
  generatedAt = new Date(),
) {
  const zip = new JSZip();
  const sensitiveTextValues = collectSensitiveTextValues(payload);
  for (const key of payload.sensitiveInputKeys || []) {
    if (!Object.prototype.hasOwnProperty.call(payload.inputs || {}, key)) continue;
    collectScalarTextValues(payload.inputs?.[key], sensitiveTextValues);
  }
  const sensitiveValues = Array.from(sensitiveTextValues)
    .sort((left, right) => right.length - left.length);
  const sanitizedPayload = redactSensitiveValues(
    payload,
    '',
    sensitiveValues,
  ) as ResultArchivePayload;
  // 这只是清洗提示，不能作为结果文件的一部分导出。
  delete sanitizedPayload.sensitiveInputKeys;
  const files = ['manifest.json', '结果摘要.md', '完整结果.json', '节点执行记录.json'];
  if (payload.inputs && Object.keys(payload.inputs).length > 0) files.push('工作流输入.json');
  if (payload.text) files.push('文本输出.txt');
  if (payload.outputs && Object.keys(payload.outputs).length > 0) files.push('工作流输出.json');
  const manifest = {
    format: 'futureFlow-result-archive',
    version: 1,
    generatedAt: generatedAt.toISOString(),
    workflowName: sanitizedPayload.workflowName || '未命名工作流',
    status: sanitizedPayload.status,
    files,
  };

  const completeResult = {
    ...sanitizedPayload,
    generatedAt: generatedAt.toISOString(),
  };
  const summary = [
    `# ${sanitizedPayload.workflowName || '工作流'}运行结果`,
    '',
    `- 状态：${sanitizedPayload.status}`,
    `- 导出时间：${generatedAt.toLocaleString('zh-CN')}`,
    sanitizedPayload.error ? `- 错误：${sanitizedPayload.error}` : '',
    '',
    '## 文本输出',
    '',
    sanitizedPayload.text || '（无文本输出，请查看完整结果文件）',
  ].filter(Boolean).join('\n');

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('结果摘要.md', summary);
  zip.file('完整结果.json', JSON.stringify(completeResult, null, 2));
  zip.file('节点执行记录.json', JSON.stringify(sanitizedPayload.nodes || [], null, 2));
  if (payload.inputs && Object.keys(payload.inputs).length > 0) {
    zip.file('工作流输入.json', JSON.stringify(sanitizedPayload.inputs, null, 2));
  }
  if (payload.text) zip.file('文本输出.txt', sanitizedPayload.text || '');
  if (payload.outputs && Object.keys(payload.outputs).length > 0) {
    zip.file('工作流输出.json', JSON.stringify(sanitizedPayload.outputs, null, 2));
  }

  return {
    zip,
    manifest,
    fileName: `${safeFileName(sanitizedPayload.workflowName || '工作流结果')}-${generatedAt.toISOString().slice(0, 19).replace(/:/g, '-')}.zip`,
  };
}

export async function downloadResultArchive(payload: ResultArchivePayload) {
  const { zip, fileName } = createResultArchive(payload);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
