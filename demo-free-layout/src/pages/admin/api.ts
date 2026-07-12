/**
 * futureFlow 管理员后台 API
 * 封装所有管理员接口调用
 */

import { getToken } from '../../utils/auth';

const GATEWAY_URL = 'http://localhost:3001';

async function adminFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  if (!token) throw new Error('未登录');

  const res = await fetch(`${GATEWAY_URL}/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `请求失败 (${res.status})`);
  }
  return data;
}

// ============ 仪表盘 ============

export function getStats() {
  return adminFetch('/stats');
}

// ============ 用户管理 ============

export function listUsers(page = 1, pageSize = 20) {
  return adminFetch(`/users?page=${page}&pageSize=${pageSize}`);
}

export function adjustBalance(userId: string, delta: number, remark: string) {
  return adminFetch(`/users/${userId}/balance`, {
    method: 'PATCH',
    body: JSON.stringify({ delta, remark }),
  });
}

export function updateVipLevel(userId: string, vipLevel: string) {
  return adminFetch(`/users/${userId}/vip`, {
    method: 'PATCH',
    body: JSON.stringify({ vipLevel }),
  });
}

export function updateUserStatus(userId: string, status: string) {
  return adminFetch(`/users/${userId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function deleteUser(userId: string) {
  return adminFetch(`/users/${userId}`, { method: 'DELETE' });
}

// ============ API Key 管理 ============

export function listApiKeys(page = 1, pageSize = 20) {
  return adminFetch(`/api-keys?page=${page}&pageSize=${pageSize}`);
}

export function revokeApiKey(id: string) {
  return adminFetch(`/api-keys/${id}`, { method: 'DELETE' });
}

// ============ 工作流管理 ============

export function listWorkflows(page = 1, pageSize = 20) {
  return adminFetch(`/workflows?page=${page}&pageSize=${pageSize}`);
}

// ============ 运行记录 ============

export function listRuns(page = 1, pageSize = 20) {
  return adminFetch(`/runs?page=${page}&pageSize=${pageSize}`);
}

// ============ 余额流水 ============

export function listBalanceLogs(page = 1, pageSize = 50, userId?: string) {
  const userIdParam = userId ? `&userId=${userId}` : '';
  return adminFetch(`/balance-logs?page=${page}&pageSize=${pageSize}${userIdParam}`);
}
