/**
 * futureFlow 认证工具
 * 管理 JWT Token 和用户信息的本地存储
 * 支持 localStorage → sessionStorage → cookie → 内存变量 降级
 */

const GATEWAY_URL = 'http://localhost:3001';
const TOKEN_KEY = 'futureflow_token';
const USER_KEY = 'futureflow_user';

let _memoryToken: string | null = null;
let _memoryUser: any | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('test');
      return localStorage;
    }
  } catch {
    // localStorage blocked (e.g., incognito)
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.getItem('test');
      return sessionStorage;
    }
  } catch {
    // sessionStorage also blocked
  }
  return null;
}

function getItem(key: string): string | null {
  const storage = getStorage();
  if (storage) {
    const val = storage.getItem(key);
    if (val !== null) return val;
  }
  // Fallback: try cookie
  const match = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
  if (match) return decodeURIComponent(match[1]);
  // Fallback: in-memory
  if (key === TOKEN_KEY) return _memoryToken;
  if (key === USER_KEY) return _memoryUser;
  return null;
}

function setItem(key: string, value: string): void {
  const storage = getStorage();
  if (storage) {
    storage.setItem(key, value);
  } else {
    document.cookie = key + '=' + encodeURIComponent(value) + '; path=/; max-age=86400';
    if (key === TOKEN_KEY) _memoryToken = value;
    if (key === USER_KEY) _memoryUser = value;
  }
}

function removeItem(key: string): void {
  const storage = getStorage();
  if (storage) {
    storage.removeItem(key);
  } else {
    document.cookie = key + '=; path=/; max-age=0';
  }
  if (key === TOKEN_KEY) _memoryToken = null;
  if (key === USER_KEY) _memoryUser = null;
}

export function getToken(): string | null {
  try {
    return getItem(TOKEN_KEY) || _memoryToken;
  } catch {
    return _memoryToken;
  }
}

export function setToken(token: string): void {
  try {
    setItem(TOKEN_KEY, token);
    _memoryToken = token;
  } catch {
    _memoryToken = token;
  }
}

export function removeToken(): void {
  try {
    removeItem(TOKEN_KEY);
    removeItem(USER_KEY);
  } catch {
    _memoryToken = null;
    _memoryUser = null;
  }
}

export function getUser(): any | null {
  try {
    const user = getItem(USER_KEY) || _memoryUser;
    return user ? JSON.parse(user) : null;
  } catch {
    return _memoryUser ? JSON.parse(_memoryUser) : null;
  }
}

export function setUser(user: any): void {
  try {
    const json = JSON.stringify(user);
    setItem(USER_KEY, json);
    _memoryUser = json;
  } catch {
    _memoryUser = JSON.stringify(user);
  }
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export async function login(
  account: string,
  password: string,
): Promise<any> {
  const res = await fetch(`${GATEWAY_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || '登录失败');
  }
  setToken(data.accessToken);
  setUser(data.user);
  return data;
}

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<any> {
  const res = await fetch(`${GATEWAY_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || '注册失败');
  }
  setToken(data.accessToken);
  setUser(data.user);
  return data;
}

export async function fetchProfile(): Promise<any> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${GATEWAY_URL}/auth/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    removeToken();
    return null;
  }
  const user = await res.json();
  setUser(user);
  return user;
}

export async function fetchVipInfo(): Promise<any> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${GATEWAY_URL}/auth/vip-info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}
