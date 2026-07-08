import {
  SIM_PROXY_BRIDGE_SOURCE,
  SIM_PROXY_WINDOW_EXECUTE,
  SIM_PROXY_WINDOW_RESULT,
  type SimProxyExecutePayload,
  type SimProxyWindowResultMessage,
} from '../shared/simProxy';

const DEFAULT_ALLOWED_ORIGIN = 'https://sim.3ue.co';
const ALLOWED_ORIGINS = new Set(['https://sim.3ue.co', 'https://sem.3ue.co']);
const MAX_RESPONSE_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 180_000;
const PRE_REQUEST_DELAY_MIN_MS = 400;
const PRE_REQUEST_DELAY_MAX_MS = 1_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const proxyWindow = window as Window & { __HACKER_EXTENSION_SIM_PROXY_PATCHED__?: boolean };
const pendingExecutions: SimProxyExecutePayload[] = [];
let isQueueDraining = false;

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

function normalizeHeaders(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => [key.trim(), typeof value === 'string' ? value : String(value)] as const)
      .filter(([key]) => key.length > 0),
  );
}

function toRequestUrl(path: string, targetOrigin: string): URL {
  const candidate = path.trim();
  if (!candidate) {
    throw new Error('请求路径不能为空');
  }

  if (!ALLOWED_ORIGINS.has(targetOrigin)) {
    throw new Error('目标站点域名不受支持');
  }

  const parsed = candidate.startsWith('http://') || candidate.startsWith('https://')
    ? new URL(candidate)
    : new URL(candidate.startsWith('/') ? candidate : `/${candidate}`, targetOrigin);

  if (!ALLOWED_ORIGINS.has(parsed.origin) || parsed.origin !== targetOrigin) {
    throw new Error('仅允许请求已配置的目标站点域名');
  }

  return parsed;
}

function truncateText(value: string): { body: string; truncated: boolean } {
  if (value.length <= MAX_RESPONSE_CHARS) {
    return { body: value, truncated: false };
  }

  return {
    body: `${value.slice(0, MAX_RESPONSE_CHARS)}\n...[truncated ${value.length - MAX_RESPONSE_CHARS} chars]`,
    truncated: true,
  };
}

function isExecutePayload(value: unknown): value is SimProxyExecutePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<SimProxyExecutePayload>;
  return (
    typeof payload.id === 'string' &&
    typeof payload.method === 'string' &&
    typeof payload.path === 'string' &&
    typeof payload.headers === 'object' &&
    payload.headers !== null &&
    typeof payload.body === 'string' &&
    typeof payload.timeoutMs === 'number'
  );
}

function postResult(message: SimProxyWindowResultMessage): void {
  window.postMessage(message, '*');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRandomPreRequestDelayMs(): number {
  const range = PRE_REQUEST_DELAY_MAX_MS - PRE_REQUEST_DELAY_MIN_MS;
  return PRE_REQUEST_DELAY_MIN_MS + Math.floor(Math.random() * (range + 1));
}

async function executeRequest(payload: SimProxyExecutePayload): Promise<void> {
  const method = payload.method.trim().toUpperCase();
  const timeoutMs = clampTimeout(payload.timeoutMs);

  if (!ALLOWED_METHODS.has(method)) {
    postResult({
      source: SIM_PROXY_BRIDGE_SOURCE,
      type: SIM_PROXY_WINDOW_RESULT,
      payload: {
        id: payload.id,
        status: 0,
        headers: {},
        body: '',
        truncated: false,
        finalUrl: '',
        error: `不支持的请求方法：${method}`,
      },
    });
    return;
  }

  let requestUrl = '';

  try {
    const pageOrigin = window.location.origin;
    if (!ALLOWED_ORIGINS.has(pageOrigin)) {
      throw new Error('当前页面不是受支持的目标站点');
    }

    const targetOrigin =
      typeof payload.origin === 'string' && payload.origin.trim().length > 0
        ? payload.origin.trim()
        : pageOrigin || DEFAULT_ALLOWED_ORIGIN;

    if (targetOrigin !== pageOrigin) {
      throw new Error('请求目标与当前页面域名不一致');
    }

    const url = toRequestUrl(payload.path, targetOrigin);
    requestUrl = url.href;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(requestUrl, {
        method,
        headers: normalizeHeaders(payload.headers),
        body: method === 'GET' ? undefined : payload.body,
        credentials: 'include',
        signal: controller.signal,
      });

      const headers = Object.fromEntries(response.headers.entries());
      const rawText = await response.text();
      const truncated = truncateText(rawText);

      postResult({
        source: SIM_PROXY_BRIDGE_SOURCE,
        type: SIM_PROXY_WINDOW_RESULT,
        payload: {
          id: payload.id,
          status: response.status,
          headers,
          body: truncated.body,
          truncated: truncated.truncated,
          finalUrl: response.url || requestUrl,
          error: '',
        },
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  } catch (error) {
    postResult({
      source: SIM_PROXY_BRIDGE_SOURCE,
      type: SIM_PROXY_WINDOW_RESULT,
      payload: {
        id: payload.id,
        status: 0,
        headers: {},
        body: '',
        truncated: false,
        finalUrl: requestUrl,
        error: error instanceof Error ? error.message : '请求失败',
      },
    });
  }
}

async function drainExecutionQueue(): Promise<void> {
  if (isQueueDraining) {
    return;
  }

  isQueueDraining = true;

  try {
    while (pendingExecutions.length > 0) {
      const nextPayload = pendingExecutions.shift();
      if (!nextPayload) {
        continue;
      }

      await sleep(getRandomPreRequestDelayMs());
      await executeRequest(nextPayload);
    }
  } finally {
    isQueueDraining = false;

    if (pendingExecutions.length > 0) {
      void drainExecutionQueue();
    }
  }
}

function enqueueExecution(payload: SimProxyExecutePayload): void {
  pendingExecutions.push(payload);
  void drainExecutionQueue();
}

if (!proxyWindow.__HACKER_EXTENSION_SIM_PROXY_PATCHED__) {
  proxyWindow.__HACKER_EXTENSION_SIM_PROXY_PATCHED__ = true;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }

    if (typeof event.data !== 'object' || event.data === null) {
      return;
    }

    const data = event.data as { source?: unknown; type?: unknown; payload?: unknown };
    if (data.source !== SIM_PROXY_BRIDGE_SOURCE || data.type !== SIM_PROXY_WINDOW_EXECUTE) {
      return;
    }

    if (!isExecutePayload(data.payload)) {
      return;
    }

    enqueueExecution(data.payload);
  });
}
