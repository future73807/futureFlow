/**
 * 统一的网关请求封装。
 * 负责附加 JWT、解析后端错误，并在登录过期时通知应用跳转登录页。
 */

import { getToken, removeToken } from './auth';
import { gatewayFetch } from './config';

export const AUTH_EXPIRED_EVENT = 'futureflow:auth-expired';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function notifyAuthExpired() {
  removeToken();
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `请求失败 (${response.status})`;

  try {
    const data = JSON.parse(text);
    const message = data?.message;
    if (Array.isArray(message)) return message.join('；');
    if (typeof message === 'string' && message) return message;
  } catch {
    // 非 JSON 错误响应，直接显示文本。
  }

  return text;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) {
    notifyAuthExpired();
    throw new ApiError('登录已过期，请重新登录', 401);
  }

  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await gatewayFetch(path, { ...options, headers });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('无法连接网关服务，请确认服务已启动', 0);
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);
    if (response.status === 401) notifyAuthExpired();
    throw new ApiError(message, response.status);
  }

  return response;
}

export async function apiJson<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
