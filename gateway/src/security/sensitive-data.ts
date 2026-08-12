const REDACTED = '[已隐藏]';

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Match credential fields without treating ordinary fields such as `author` as secrets. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized === 'auth'
    || normalized.endsWith('auth')
    || normalized.endsWith('authorization')
    || normalized.endsWith('apikey')
    || normalized.endsWith('password')
    || normalized.endsWith('passwd')
    || normalized.endsWith('token')
    || normalized.includes('clientsecret')
    || normalized.endsWith('secret')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized === 'cookie'
    || normalized === 'setcookie';
}

/**
 * Remove values that are known to have flowed into a credential position.
 * This complements key-based redaction for opaque response bodies that echo
 * an Authorization header as plain text.
 */
export function redactSensitiveValues<T>(
  value: T,
  sensitiveValues: Iterable<unknown>,
): T {
  const secrets = Array.from(new Set(
    Array.from(sensitiveValues)
      .filter((candidate): candidate is string => (
        typeof candidate === 'string'
        && candidate.length > 0
        && candidate !== REDACTED
      )),
  )).sort((left, right) => right.length - left.length);
  if (secrets.length === 0) return value;

  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') {
      return secrets.reduce(
        (safe, secret) => safe.split(secret).join(REDACTED),
        candidate,
      );
    }
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item));
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).map(([key, child]) => [
        key,
        visit(child),
      ]),
    );
  };

  return visit(value) as T;
}

function redactShape(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'content')) {
      return { ...record, content: REDACTED };
    }
  }
  return REDACTED;
}

/** Keep input keys and nesting visible while hiding every runtime value. */
export function redactInputValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactInputValues(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactInputValues(child),
      ]),
    );
  }
  return value === undefined ? undefined : REDACTED;
}

/** Preserve FlowValue metadata such as `type`, but never its invocation value. */
function redactRunInputShape(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => redactRunInputShape(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactRunInputShape(child, childKey),
      ]),
    );
  }
  if (normalizeKey(key) === 'type' && typeof value === 'string') return value;
  return value === undefined ? undefined : REDACTED;
}

function sanitizeUrl(value: string): string {
  try {
    const absolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'http://futureflow.invalid');
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return absolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function sanitizeHeaderLine(line: string): string {
  const separator = line.indexOf(':');
  if (separator <= 0) return line;
  const name = line.slice(0, separator).trim();
  return isSensitiveKey(name) ? `${line.slice(0, separator + 1)} ${REDACTED}` : line;
}

function sanitizeBody(body: string, headerLines: string[]): string {
  if (!body) return body;
  const contentType = headerLines
    .find((line) => /^content-type\s*:/i.test(line))
    ?.slice(lineIndexAfterColon(headerLines.find((line) => /^content-type\s*:/i.test(line))!))
    .trim()
    .toLowerCase() || '';
  if (contentType.includes('json') || /^[\s]*[\[{]/.test(body)) {
    try {
      return JSON.stringify(sanitizeSensitiveData(JSON.parse(body)), null, 2);
    } catch {
      return body;
    }
  }
  if (contentType.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    for (const key of Array.from(params.keys())) {
      if (isSensitiveKey(key)) params.set(key, REDACTED);
    }
    return params.toString();
  }
  return body;
}

function lineIndexAfterColon(line: string): number {
  const index = line.indexOf(':');
  return index < 0 ? 0 : index + 1;
}

/** Redact a Dify HTTP node request transcript without global string replacement. */
export function sanitizeHttpRequestLog(value: string): string {
  const boundary = /\r?\n\r?\n/.exec(value);
  const head = boundary ? value.slice(0, boundary.index) : value;
  const separator = boundary?.[0] || '';
  const body = boundary ? value.slice(boundary.index + separator.length) : '';
  const newline = head.includes('\r\n') ? '\r\n' : '\n';
  const lines = head.split(/\r?\n/);
  if (lines[0]) {
    lines[0] = lines[0].replace(
      /^(\S+\s+)(\S+)(\s+HTTP\/\d(?:\.\d)?)$/,
      (_match, prefix: string, target: string, suffix: string) => `${prefix}${sanitizeUrl(target)}${suffix}`,
    );
  }
  const sanitizedHeaders = lines.map((line, index) => (index === 0 ? line : sanitizeHeaderLine(line)));
  return sanitizedHeaders.join(newline)
    + separator
    + sanitizeBody(body, lines.slice(1));
}

function sanitizeHeaderContainer(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split(/(\r?\n)/).map((part) => (/^\r?\n$/.test(part) ? part : sanitizeHeaderLine(part))).join('');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? redactShape(child) : sanitizeSensitiveData(child, key),
    ]),
  );
}

/** Recursively redact credential-shaped fields while preserving unrelated business data. */
export function sanitizeSensitiveData(value: unknown, key = ''): unknown {
  const normalized = normalizeKey(key);
  if (typeof value === 'string' && (normalized === 'request' || normalized === 'rawrequest')) {
    return sanitizeHttpRequestLog(value);
  }
  if (normalized === 'headers' || normalized === 'headervalues' || normalized === 'requestheaders') {
    return sanitizeHeaderContainer(value);
  }
  if (isSensitiveKey(key)) return redactShape(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeSensitiveData(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitizeSensitiveData(child, childKey),
    ]),
  );
}

/**
 * Build a run audit snapshot without mutating the executable definition.
 * Start-node inputsValues are invocation data, so retain their field/FlowValue
 * structure for diagnostics but never persist their resolved values.
 */
export function sanitizeWorkflowRunSnapshot<T>(flowgram: T): T {
  const sanitized = sanitizeSensitiveData(flowgram) as T;
  const source = flowgram as any;
  const target = sanitized as any;
  if (!Array.isArray(source?.nodes) || !Array.isArray(target?.nodes)) return sanitized;

  const sourceById = new Map(source.nodes.map((node: any) => [node?.id, node]));
  for (const node of target.nodes) {
    if (node?.type !== 'start') continue;
    const sourceNode: any = sourceById.get(node.id);
    if (!sourceNode?.data?.inputsValues || typeof sourceNode.data.inputsValues !== 'object') continue;
    node.data = { ...(node.data || {}) };
    node.data.inputsValues = redactRunInputShape(sourceNode.data.inputsValues);
  }
  return sanitized;
}

