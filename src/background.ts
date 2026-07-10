import {
  CREATE_NOTION_RECORD,
  GET_NOTION_CACHE,
  SYNC_NOTION_DATABASE,
  UPDATE_NOTION_RECORD,
  createNotionFailure,
  createNotionRecord,
  fetchNotionDatabase,
  getNotionErrorMessage,
  updateNotionRecord,
  type NotionBackgroundRequest,
  type NotionBackgroundResponse,
  type NotionCachePayload,
  type NotionFormValues,
} from './shared/notion';
import {
  CAPTURE_APPEND,
  CAPTURE_CLEAR,
  CAPTURE_EXPORT,
  CAPTURE_GET_STATE,
  CAPTURE_START,
  CAPTURE_STOP,
  compileCaptureMatcher,
  createCaptureFailure,
  isCaptureUrlMatched,
  type CaptureAppendPayload,
  type CaptureBackgroundRequest,
  type CaptureExportPayload,
  type CaptureMatcher,
  type CaptureStatePayload,
} from './shared/capture';
import {
  clearCaptureRecords,
  getCaptureRecords,
  getCaptureRule,
  getCaptureRuntimeState,
  getNotionCache,
  getNotionConfig,
  getNotionSyncState,
  getPanelEnabled,
  getSimProxyBridgeConfig,
  getSimProxyInFlightRecord,
  getSimProxyInFlightStore,
  setCaptureRecords,
  setSimProxyBridgeConfig,
  setCaptureRule,
  setCaptureRuntimeState,
  setNotionCache,
  setNotionSyncState,
  upsertSimProxyInFlightRecord,
  deleteSimProxyInFlightRecord,
} from './shared/storage';
import {
  DEFAULT_CAPTURE_RUNTIME_STATE,
  DEFAULT_NOTION_SYNC_STATE,
  type CaptureRecord,
  type CaptureRecordSummary,
  type CaptureRuntimeState,
  type SimProxyBridgeConfig,
  type SimProxyInFlightRecord,
} from './shared/types';
import {
  SIM_PROXY_EXECUTE,
  SIM_PROXY_RESULT,
  SIM_PROXY_STATUS,
  SIM_PROXY_WAKEUP,
  SIM_PROXY_PORT_DISPATCH_ACK,
  SIM_PROXY_PORT_EXECUTE,
  SIM_PROXY_PORT_HEARTBEAT,
  SIM_PROXY_PORT_HELLO,
  SIM_PROXY_PORT_NAME,
  SIM_PROXY_PORT_RESULT,
  createSimProxyFailure,
  type SimProxyBackgroundRequest,
  type SimProxyBackgroundResponse,
  type SimProxyBridgeStatusPayload,
  type SimProxyExecutePayload,
  type SimProxyPortDispatchAckMessage,
  type SimProxyPortInboundMessage,
  type SimProxyPortOutboundMessage,
  type SimProxyPortResultMessage,
  type SimProxyResultAck,
  type SimProxyResultPayload,
  type SimProxyStatusLevel,
} from './shared/simProxy';
import {
  NATIVE_HOST_NAME,
  NATIVE_HOST_START,
  NATIVE_HOST_STATUS,
  NATIVE_HOST_STOP,
  createNativeHostFailure,
  type NativeHostAction,
  type NativeHostBackgroundRequest,
  type NativeHostBackgroundResponse,
  type NativeHostControlRequest,
  type NativeHostControlResponse,
  type NativeHostFailureError,
  type NativeHostState,
} from './shared/nativeHost';

let notionSyncInFlight: Promise<NotionCachePayload> | null = null;
let captureState: CaptureRuntimeState = DEFAULT_CAPTURE_RUNTIME_STATE;
let captureRecords: CaptureRecord[] = [];
let captureMatcher: CaptureMatcher | null = null;

const MAX_CAPTURE_RECORDS = 400;
const MAX_CAPTURE_TOTAL_CHARS = 4_000_000;

const SIM_PROXY_SIM_ORIGIN = 'https://sim.3ue.co';
const SIM_PROXY_SEM_ORIGIN = 'https://sem.3ue.co';
const SIM_PROXY_DEFAULT_ALLOWED_ORIGIN = SIM_PROXY_SIM_ORIGIN;
const SIM_PROXY_ALLOWED_ORIGINS = new Set([SIM_PROXY_SIM_ORIGIN, SIM_PROXY_SEM_ORIGIN]);
const SIM_PROXY_POLL_MAX_WAIT_MS = 25_000;
const SIM_PROXY_POLL_REQUEST_TIMEOUT_MS = 30_000;
const SIM_PROXY_RESULT_TIMEOUT_BUFFER_MS = 20_000;
const SIM_PROXY_RESULT_POST_TIMEOUT_MS = 15_000;
const SIM_PROXY_RETRY_DELAY_MS = 2_000;
const SIM_PROXY_MIN_TIMEOUT_MS = 1_000;
const SIM_PROXY_DEFAULT_TIMEOUT_MS = 45_000;
const SIM_PROXY_MAX_TIMEOUT_MS = 180_000;
const SIM_PROXY_ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_SIM_PROXY_BASE_URL = 'http://127.0.0.1:17311';
const DEFAULT_SIM_PROXY_PORT = 17311;
const SIM_PROXY_POLL_ALARM = 'sim-proxy-poll';
const SIM_PROXY_POLL_ALARM_PERIOD_MINUTES = 0.5;
const SIM_PROXY_SEND_MESSAGE_RETRY_LIMIT = 2;
const SIM_PROXY_RESULT_POST_RETRY_LIMIT = 3;
const SIM_PROXY_RESULT_POST_RETRY_BASE_DELAY_MS = 400;
const SIM_PROXY_EXECUTOR_HEARTBEAT_STALE_MS = 60_000;
const SIM_PROXY_DISPATCH_ACK_TIMEOUT_MS = 3_000;
const SIM_PROXY_EXECUTOR_SESSION_WAIT_TIMEOUT_MS = 8_000;
const SIM_PROXY_EXECUTOR_SESSION_WAIT_STEP_MS = 120;
const SIM_PROXY_EXECUTOR_ENSURE_INTERVAL_MS = 20_000;

function isNativeHostControlResponse(value: unknown): value is NativeHostControlResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const response = value as Partial<NativeHostControlResponse>;
  if (response.ok === true) {
    const data = (response as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) {
      return false;
    }

    const state = data as Partial<NativeHostState>;
    return (
      typeof state.running === 'boolean' &&
      (typeof state.pid === 'number' || state.pid === null) &&
      typeof state.baseUrl === 'string' &&
      typeof state.token === 'string' &&
      (typeof state.startedAt === 'number' || state.startedAt === null) &&
      typeof state.hostName === 'string'
    );
  }

  if (response.ok === false) {
    const error = (response as { error?: unknown }).error;
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { message?: unknown }).message === 'string'
    );
  }

  return false;
}

function toNativeHostAction(command: NativeHostControlRequest): NativeHostAction {
  if (command.command === 'start') {
    return 'start';
  }

  if (command.command === 'stop') {
    return 'stop';
  }

  return 'status';
}

function createNativeHostError(
  code: NativeHostFailureError['code'],
  message: string,
  action: NativeHostAction,
  rawMessage?: string,
  hint?: string,
): NativeHostFailureError {
  return {
    code,
    message,
    action,
    rawMessage,
    hint,
  };
}

function normalizeNativeHostTransportError(rawMessage: string, action: NativeHostAction): NativeHostFailureError {
  if (rawMessage.includes('Specified native messaging host not found')) {
    return createNativeHostError('INSTALL_MISSING', '未找到 Native host。请先执行安装命令并重启浏览器后重试。', action, rawMessage);
  }

  if (rawMessage.includes('Native host has exited')) {
    const maybeNodeMissing = /node(\.js)? runtime not found|env: node: No such file or directory/i.test(rawMessage);
    if (maybeNodeMissing) {
      return createNativeHostError(
        'NODE_MISSING',
        '浏览器环境未找到 Node.js。请安装 Node 后重新执行安装命令。',
        action,
        rawMessage,
        '可在 options 复制并执行：npm run native:install:mac -- --extension-id=<扩展ID>',
      );
    }

    return createNativeHostError(
      'HOST_EXITED',
      'Native host 进程已退出。请确认已执行安装命令后重试。',
      action,
      rawMessage,
      '可在 options 复制并执行：npm run native:install:mac -- --extension-id=<扩展ID>',
    );
  }

  if (/forbidden|permission denied|access.*forbidden/i.test(rawMessage)) {
    return createNativeHostError('PERMISSION_OR_PATH', 'Native host 权限或路径异常，请重新安装并检查本地文件权限。', action, rawMessage);
  }

  return createNativeHostError(
    'HOST_ERROR',
    rawMessage ? `本地宿主调用失败：${rawMessage}` : '本地宿主调用失败',
    action,
    rawMessage || undefined,
  );
}

function normalizeNativeHostRuntimeError(error: { code: string; message: string }, action: NativeHostAction): NativeHostFailureError {
  const code = error.code;
  if (code === 'SERVICE_STARTUP_FAILED') {
    return createNativeHostError('SERVICE_STARTUP_FAILED', error.message || '本地服务启动失败。', action);
  }

  if (code === 'STOP_FAILED') {
    return createNativeHostError('STOP_FAILED', error.message || '本地服务停止失败。', action);
  }

  if (code === 'STATUS_UNAVAILABLE') {
    return createNativeHostError('STATUS_UNAVAILABLE', error.message || '本地服务状态不可用。', action);
  }

  if (code === 'SERVICE_PATH_MISSING') {
    return createNativeHostError('SERVICE_PATH_MISSING', error.message || '本地服务脚本不存在，请重新安装。', action);
  }

  if (code === 'SERVICE_SPAWN_FAILED') {
    return createNativeHostError('SERVICE_SPAWN_FAILED', error.message || '本地服务进程拉起失败。', action);
  }

  if (code === 'INVALID_REQUEST' || code === 'UNSUPPORTED_COMMAND') {
    return createNativeHostError(code, error.message || '本地宿主请求无效。', action);
  }

  return createNativeHostError(code || 'HOST_ERROR', error.message || '本地宿主执行失败。', action);
}

async function requestNativeHost(command: NativeHostControlRequest): Promise<NativeHostState> {
  const action = toNativeHostAction(command);
  let response: unknown;

  try {
    response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, command)) as unknown;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    throw normalizeNativeHostTransportError(rawMessage, action);
  }

  if (!isNativeHostControlResponse(response)) {
    throw createNativeHostError('HOST_RESPONSE_INVALID', '本地宿主返回格式无效。请重试或重新安装 Native host。', action);
  }

  if (!response.ok) {
    throw normalizeNativeHostRuntimeError(response.error, action);
  }

  return response.data;
}

async function syncSimProxyConfigFromNativeState(state: NativeHostState): Promise<void> {
  const current = await getSimProxyBridgeConfig();
  const next = {
    enabled: true,
    baseUrl: state.baseUrl.trim() || DEFAULT_SIM_PROXY_BASE_URL,
    token: state.token.trim() || current.token,
    autoMaintainExecutors: current.autoMaintainExecutors,
    pinExecutorTabs: current.pinExecutorTabs,
  } satisfies SimProxyBridgeConfig;

  await setSimProxyBridgeConfig(next);
}

type SimProxyBridgeJob = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  origin: string;
};

type SimProxyPendingRequest = {
  resolve: (payload: SimProxyResultPayload) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type SimProxyOriginKey = 'sim' | 'sem';

type SimProxyExecutorSession = {
  tabId: number;
  origin: string;
  pageUrl: string;
  port: chrome.runtime.Port;
  connectedAt: number;
  lastHeartbeatAt: number;
};

type SimProxyDispatchAckWaiter = {
  resolve: (payload: SimProxyPortDispatchAckMessage) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const simProxyPendingRequests = new Map<string, SimProxyPendingRequest>();
let simProxyPollLoopRunning = false;

const simProxyExecutorSessions = new Map<number, SimProxyExecutorSession>();
const simProxyMaintainedExecutorTabs: Record<SimProxyOriginKey, number | null> = {
  sim: null,
  sem: null,
};
const simProxyDispatchAckWaiters = new Map<string, SimProxyDispatchAckWaiter>();
const simProxyRequestExecutors = new Map<string, number>();
let simProxyEnsureExecutorsTimerId: ReturnType<typeof setTimeout> | null = null;
const simProxyExecutorBinding = simProxyMaintainedExecutorTabs;

const simProxyFailoverState = {
  count: 0,
  lastAt: null as number | null,
  lastReason: '',
};

type SimProxyHealthSnapshot = {
  ok: boolean;
  status: 'up' | 'down' | 'unknown';
  pendingJobs: number | null;
  waitingResults: number | null;
  waitingPollers: number | null;
  lastCheckedAt: number | null;
  lastError: string;
};


type SimProxyRuntimeState = {
  poll: {
    lastPollAt: number | null;
    lastPollOkAt: number | null;
    lastPollError: string;
  };
  dispatch: {
    lastJobId: string;
    lastOrigin: string;
    lastDispatchAt: number | null;
    lastDispatchError: string;
  };
  result: {
    lastResultReceivedAt: number | null;
    lastResultPostedAt: number | null;
    lastResultPostError: string;
  };
  health: SimProxyHealthSnapshot;
};

const SIM_PROXY_STATUS_HEALTH_TIMEOUT_MS = 3_000;

const simProxyRuntimeState: SimProxyRuntimeState = {
  poll: {
    lastPollAt: null,
    lastPollOkAt: null,
    lastPollError: '',
  },
  dispatch: {
    lastJobId: '',
    lastOrigin: '',
    lastDispatchAt: null,
    lastDispatchError: '',
  },
  result: {
    lastResultReceivedAt: null,
    lastResultPostedAt: null,
    lastResultPostError: '',
  },
  health: {
    ok: false,
    status: 'unknown',
    pendingJobs: null,
    waitingResults: null,
    waitingPollers: null,
    lastCheckedAt: null,
    lastError: '',
  },
};

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return fallback;
}

function updateSimProxyHealth(partial: Partial<SimProxyHealthSnapshot>): void {
  simProxyRuntimeState.health = {
    ...simProxyRuntimeState.health,
    ...partial,
  };
}

function isKnownSimProxyOrigin(origin: string): origin is typeof SIM_PROXY_SIM_ORIGIN | typeof SIM_PROXY_SEM_ORIGIN {
  return SIM_PROXY_ALLOWED_ORIGINS.has(origin);
}

function toSimProxyOriginKey(origin: string): SimProxyOriginKey | null {
  if (origin === SIM_PROXY_SIM_ORIGIN) {
    return 'sim';
  }

  if (origin === SIM_PROXY_SEM_ORIGIN) {
    return 'sem';
  }

  return null;
}

function toSimProxyOriginByKey(key: SimProxyOriginKey): string {
  return key === 'sim' ? SIM_PROXY_SIM_ORIGIN : SIM_PROXY_SEM_ORIGIN;
}

function isSimProxySessionStale(session: SimProxyExecutorSession, now = Date.now()): boolean {
  return now - session.lastHeartbeatAt > SIM_PROXY_EXECUTOR_HEARTBEAT_STALE_MS;
}

function getHealthySessionCandidates(origin: string, excludedTabIds?: Set<number>): SimProxyExecutorSession[] {
  const now = Date.now();
  return [...simProxyExecutorSessions.values()]
    .filter((session) => session.origin === origin)
    .filter((session) => !excludedTabIds?.has(session.tabId))
    .filter((session) => !isSimProxySessionStale(session, now))
    .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
}

function bindSimProxyExecutor(origin: string, tabId: number): void {
  const key = toSimProxyOriginKey(origin);
  if (!key) {
    return;
  }

  simProxyExecutorBinding[key] = tabId;
}

function unbindSimProxyExecutor(tabId: number): void {
  for (const key of Object.keys(simProxyExecutorBinding) as SimProxyOriginKey[]) {
    if (simProxyExecutorBinding[key] === tabId) {
      simProxyExecutorBinding[key] = null;
    }
  }
}

function recordSimProxyFailover(reason: string): void {
  simProxyFailoverState.count += 1;
  simProxyFailoverState.lastAt = Date.now();
  simProxyFailoverState.lastReason = reason;
}

function getExecutorHealthByKey(key: SimProxyOriginKey): {
  tabId: number | null;
  lastHeartbeatAt: number | null;
  stale: boolean;
} {
  const tabId = simProxyExecutorBinding[key];
  if (tabId == null) {
    return {
      tabId: null,
      lastHeartbeatAt: null,
      stale: false,
    };
  }

  const session = simProxyExecutorSessions.get(tabId);
  if (!session) {
    return {
      tabId,
      lastHeartbeatAt: null,
      stale: true,
    };
  }

  return {
    tabId: session.tabId,
    lastHeartbeatAt: session.lastHeartbeatAt,
    stale: isSimProxySessionStale(session),
  };
}

function clearDispatchAckWaiter(requestId: string): void {
  const waiter = simProxyDispatchAckWaiters.get(requestId);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timeoutId);
  simProxyDispatchAckWaiters.delete(requestId);
}

function rejectDispatchAckWaiter(requestId: string, message: string): void {
  const waiter = simProxyDispatchAckWaiters.get(requestId);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timeoutId);
  simProxyDispatchAckWaiters.delete(requestId);
  waiter.reject(new Error(message));
}

function resolveDispatchAckWaiter(payload: SimProxyPortDispatchAckMessage): void {
  const waiter = simProxyDispatchAckWaiters.get(payload.id);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timeoutId);
  simProxyDispatchAckWaiters.delete(payload.id);
  waiter.resolve(payload);
}

function waitForDispatchAck(requestId: string, timeoutMs: number): Promise<SimProxyPortDispatchAckMessage> {
  return new Promise((resolve, reject) => {
    clearDispatchAckWaiter(requestId);

    const timeoutId = setTimeout(() => {
      simProxyDispatchAckWaiters.delete(requestId);
      reject(new Error('等待执行页 ACK 超时'));
    }, timeoutMs);

    simProxyDispatchAckWaiters.set(requestId, {
      resolve,
      reject,
      timeoutId,
    });
  });
}

function isSimProxyPortDispatchAckMessage(value: unknown): value is SimProxyPortDispatchAckMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<SimProxyPortDispatchAckMessage>;
  return (
    payload.type === SIM_PROXY_PORT_DISPATCH_ACK &&
    typeof payload.id === 'string' &&
    typeof payload.accepted === 'boolean' &&
    (payload.error == null || typeof payload.error === 'string')
  );
}

function isSimProxyPortResultMessage(value: unknown): value is SimProxyPortResultMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<SimProxyPortResultMessage>;
  return payload.type === SIM_PROXY_PORT_RESULT && isSimProxyResultPayload(payload.payload);
}

function isSimProxyPortHelloMessage(value: unknown): value is { type: typeof SIM_PROXY_PORT_HELLO; origin: string; pageUrl: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as { type?: unknown; origin?: unknown; pageUrl?: unknown };
  return payload.type === SIM_PROXY_PORT_HELLO && typeof payload.origin === 'string' && typeof payload.pageUrl === 'string';
}

function isSimProxyPortHeartbeatMessage(
  value: unknown,
): value is { type: typeof SIM_PROXY_PORT_HEARTBEAT; origin: string; pageUrl: string; sentAt: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as { type?: unknown; origin?: unknown; pageUrl?: unknown; sentAt?: unknown };
  return (
    payload.type === SIM_PROXY_PORT_HEARTBEAT &&
    typeof payload.origin === 'string' &&
    typeof payload.pageUrl === 'string' &&
    typeof payload.sentAt === 'number'
  );
}

async function waitForSimProxySession(tabId: number, timeoutMs: number): Promise<SimProxyExecutorSession | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = simProxyExecutorSessions.get(tabId);
    if (session && !isSimProxySessionStale(session)) {
      return session;
    }

    await sleep(SIM_PROXY_EXECUTOR_SESSION_WAIT_STEP_MS);
  }

  return null;
}

async function discoverSimProxySession(origin: string, excludedTabIds?: Set<number>): Promise<SimProxyExecutorSession | null> {
  const urlPattern = [`${origin}/*`];
  const tabs = await chrome.tabs.query({ url: urlPattern });
  const candidates = tabs
    .map((tab) => tab.id)
    .filter((tabId): tabId is number => typeof tabId === 'number')
    .filter((tabId) => !excludedTabIds?.has(tabId));

  for (const tabId of candidates) {
    try {
      await ensureSimProxyBridgeScriptsInjected(tabId);
    } catch {
      continue;
    }

    const session = await waitForSimProxySession(tabId, SIM_PROXY_EXECUTOR_SESSION_WAIT_TIMEOUT_MS);
    if (session && session.origin === origin) {
      return session;
    }
  }

  return null;
}

async function resolveExecutorSession(origin: string, excludedTabIds?: Set<number>): Promise<SimProxyExecutorSession | null> {
  const originKey = toSimProxyOriginKey(origin);
  if (!originKey) {
    return null;
  }

  const boundTabId = simProxyExecutorBinding[originKey];
  if (boundTabId != null && !excludedTabIds?.has(boundTabId)) {
    const boundSession = simProxyExecutorSessions.get(boundTabId);
    if (boundSession && !isSimProxySessionStale(boundSession)) {
      return boundSession;
    }

    simProxyExecutorBinding[originKey] = null;
  }

  const healthyCandidates = getHealthySessionCandidates(origin, excludedTabIds);
  const next = healthyCandidates[0];
  if (next) {
    bindSimProxyExecutor(origin, next.tabId);
    return next;
  }

  const discovered = await discoverSimProxySession(origin, excludedTabIds);
  if (discovered) {
    bindSimProxyExecutor(origin, discovered.tabId);
    return discovered;
  }

  return null;
}

function toTabOrigin(url?: string): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

async function getSimProxyTabById(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}


async function isTabOnOrigin(tabId: number, origin: string): Promise<boolean> {
  const tab = await getSimProxyTabById(tabId);
  if (!tab) {
    return false;
  }

  const tabOrigin = toTabOrigin(tab.url);
  return tabOrigin === origin;
}

async function ensureTabPinned(tabId: number, pinned: boolean): Promise<void> {
  try {
    await chrome.tabs.update(tabId, {
      pinned,
      autoDiscardable: false,
    });
  } catch {
    try {
      await chrome.tabs.update(tabId, { pinned });
    } catch {
      // noop
    }
  }
}

async function createMaintainedExecutorTab(origin: string, config: SimProxyBridgeConfig): Promise<number | null> {
  try {
    const created = await chrome.tabs.create({
      url: `${origin}/`,
      active: false,
      pinned: config.pinExecutorTabs,
    });

    if (typeof created.id !== 'number') {
      return null;
    }

    await ensureTabPinned(created.id, config.pinExecutorTabs);
    return created.id;
  } catch {
    return null;
  }
}

async function ensureExecutorForOrigin(key: SimProxyOriginKey, config: SimProxyBridgeConfig): Promise<void> {
  const origin = toSimProxyOriginByKey(key);
  let targetTabId = simProxyMaintainedExecutorTabs[key];

  if (typeof targetTabId === 'number') {
    const stillOnOrigin = await isTabOnOrigin(targetTabId, origin);
    if (!stillOnOrigin) {
      simProxyMaintainedExecutorTabs[key] = null;
      targetTabId = null;
    }
  }

  if (targetTabId == null) {
    const existingTabs = await chrome.tabs.query({ url: [`${origin}/*`] });
    const existing = existingTabs.find((tab) => typeof tab.id === 'number');
    if (existing?.id != null) {
      targetTabId = existing.id;
    }
  }

  if (targetTabId == null) {
    targetTabId = await createMaintainedExecutorTab(origin, config);
  }

  if (targetTabId == null) {
    return;
  }

  simProxyMaintainedExecutorTabs[key] = targetTabId;
  bindSimProxyExecutor(origin, targetTabId);

  await ensureTabPinned(targetTabId, config.pinExecutorTabs);

  try {
    await ensureSimProxyBridgeScriptsInjected(targetTabId);
  } catch {
    return;
  }

  const session = await waitForSimProxySession(targetTabId, SIM_PROXY_EXECUTOR_SESSION_WAIT_TIMEOUT_MS);
  if (session && session.origin === origin) {
    bindSimProxyExecutor(origin, targetTabId);
  }
}

async function ensureSimProxyExecutorsOnce(config?: SimProxyBridgeConfig): Promise<void> {
  const currentConfig = config ?? (await getSimProxyBridgeConfig());
  if (!isSimProxyBridgeEnabled(currentConfig) || !currentConfig.autoMaintainExecutors) {
    return;
  }

  await ensureExecutorForOrigin('sim', currentConfig);
  await ensureExecutorForOrigin('sem', currentConfig);
}

function scheduleSimProxyExecutorMaintenance(delayMs = 0): void {
  if (simProxyEnsureExecutorsTimerId != null) {
    return;
  }

  simProxyEnsureExecutorsTimerId = setTimeout(() => {
    simProxyEnsureExecutorsTimerId = null;

    void (async () => {
      const config = await getSimProxyBridgeConfig();
      if (!isSimProxyBridgeEnabled(config) || !config.autoMaintainExecutors) {
        return;
      }

      await ensureSimProxyExecutorsOnce(config);
      scheduleSimProxyExecutorMaintenance(SIM_PROXY_EXECUTOR_ENSURE_INTERVAL_MS);
    })();
  }, delayMs);
}

function stopSimProxyExecutorMaintenance(): void {
  if (simProxyEnsureExecutorsTimerId == null) {
    return;
  }

  clearTimeout(simProxyEnsureExecutorsTimerId);
  simProxyEnsureExecutorsTimerId = null;
}

function upsertExecutorSession(session: SimProxyExecutorSession): void {
  simProxyExecutorSessions.set(session.tabId, session);
  bindSimProxyExecutor(session.origin, session.tabId);
}

function removeExecutorSession(tabId: number, reason?: string): void {
  const existing = simProxyExecutorSessions.get(tabId);
  if (!existing) {
    return;
  }

  simProxyExecutorSessions.delete(tabId);
  unbindSimProxyExecutor(tabId);

  for (const key of Object.keys(simProxyMaintainedExecutorTabs) as SimProxyOriginKey[]) {
    if (simProxyMaintainedExecutorTabs[key] === tabId) {
      simProxyMaintainedExecutorTabs[key] = null;
    }
  }

  for (const [requestId, ownerTabId] of simProxyRequestExecutors.entries()) {
    if (ownerTabId !== tabId) {
      continue;
    }

    rejectDispatchAckWaiter(requestId, '执行页连接中断，派发 ACK 失败');
    simProxyRequestExecutors.delete(requestId);
  }

  if (reason) {
    recordSimProxyFailover(reason);
  }

  scheduleSimProxyExecutorMaintenance();
}

function onSimProxyPortMessage(tabId: number, rawMessage: unknown): void {
  if (isSimProxyPortDispatchAckMessage(rawMessage)) {
    resolveDispatchAckWaiter(rawMessage);
    return;
  }

  if (isSimProxyPortResultMessage(rawMessage)) {
    void handleSimProxyResultPayload(rawMessage.payload);
    return;
  }

  if (isSimProxyPortHeartbeatMessage(rawMessage)) {
    const origin = rawMessage.origin.trim();
    if (!isKnownSimProxyOrigin(origin)) {
      return;
    }

    const current = simProxyExecutorSessions.get(tabId);
    if (!current) {
      return;
    }

    upsertExecutorSession({
      ...current,
      origin,
      pageUrl: rawMessage.pageUrl,
      lastHeartbeatAt: Date.now(),
    });
    return;
  }

  if (isSimProxyPortHelloMessage(rawMessage)) {
    const origin = rawMessage.origin.trim();
    if (!isKnownSimProxyOrigin(origin)) {
      return;
    }

    const current = simProxyExecutorSessions.get(tabId);
    if (!current) {
      return;
    }

    upsertExecutorSession({
      ...current,
      origin,
      pageUrl: rawMessage.pageUrl,
      lastHeartbeatAt: Date.now(),
    });
  }
}


function registerSimProxyPort(port: chrome.runtime.Port): void {
  if (port.name !== SIM_PROXY_PORT_NAME) {
    return;
  }

  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') {
    try {
      port.disconnect();
    } catch {
      // noop
    }
    return;
  }

  const pageUrl = port.sender?.tab?.url || '';
  const origin = toTabOrigin(pageUrl);
  if (!origin || !isKnownSimProxyOrigin(origin)) {
    try {
      port.disconnect();
    } catch {
      // noop
    }
    return;
  }

  const existing = simProxyExecutorSessions.get(tabId);
  if (existing && existing.port !== port) {
    removeExecutorSession(tabId, `tab ${tabId} 已建立新连接`);
  }

  upsertExecutorSession({
    tabId,
    origin,
    pageUrl,
    port,
    connectedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  });

  port.onMessage.addListener((rawMessage: unknown) => {
    onSimProxyPortMessage(tabId, rawMessage as SimProxyPortInboundMessage);
  });

  port.onDisconnect.addListener(() => {
    removeExecutorSession(tabId, `tab ${tabId} 连接断开`);
  });
}


async function sendExecuteViaSendMessageFallback(tabId: number, payload: SimProxyExecutePayload): Promise<void> {
  for (let attempt = 0; attempt < SIM_PROXY_SEND_MESSAGE_RETRY_LIMIT; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: SIM_PROXY_EXECUTE,
        payload,
      } satisfies SimProxyBackgroundRequest);
      return;
    } catch (error) {
      const canRecover = isMissingReceiverError(error) && attempt < SIM_PROXY_SEND_MESSAGE_RETRY_LIMIT - 1;
      if (!canRecover) {
        throw error;
      }

      await ensureSimProxyBridgeScriptsInjected(tabId);
    }
  }
}

function getSimProxyStatusSummary(level: SimProxyStatusLevel, state: SimProxyBridgeStatusPayload): string {
  if (level === 'error') {
    if (!state.config.hasToken) {
      return '缺少 BRIDGE_TOKEN，请先在设置中保存。';
    }

    if (!state.health.ok) {
      return state.health.lastError || '本地服务不可达，请先启动并检查地址。';
    }

    if (state.poll.lastPollError) {
      return `轮询失败：${state.poll.lastPollError}`;
    }

    if (state.result.lastResultPostError) {
      return `结果回传失败：${state.result.lastResultPostError}`;
    }

    return '代理链路异常，请检查本地服务与扩展状态。';
  }

  if (level === 'warn') {
    if (state.health.waitingResults != null && state.health.waitingResults > 0) {
      return `存在 ${state.health.waitingResults} 个等待结果任务，可能页面回传缓慢。`;
    }

    if (
      state.health.pendingJobs != null &&
      state.health.pendingJobs > 0 &&
      state.health.waitingPollers != null &&
      state.health.waitingPollers === 0
    ) {
      return '检测到任务堆积，扩展可能未持续轮询。';
    }

    if (state.dispatch.executor.sim.stale || state.dispatch.executor.sem.stale) {
      return '执行页心跳已过期，正在尝试切换到可用页面。';
    }

    if (state.dispatch.lastDispatchError) {
      return `页面派发失败：${state.dispatch.lastDispatchError}`;
    }

    if (state.dispatch.executor.lastFailoverReason) {
      return `已自动切换执行页：${state.dispatch.executor.lastFailoverReason}`;
    }

    return '代理链路有告警，建议执行一次链路检查。';
  }

  return '代理链路正常。';
}

function getSimProxyStatusLevel(state: Omit<SimProxyBridgeStatusPayload, 'level' | 'summary' | 'checkedAt'>): SimProxyStatusLevel {
  if (!state.config.hasToken || !state.health.ok || !!state.poll.lastPollError || !!state.result.lastResultPostError) {
    return 'error';
  }

  if (
    !!state.dispatch.lastDispatchError ||
    state.dispatch.executor.sim.stale ||
    state.dispatch.executor.sem.stale ||
    (state.health.waitingResults != null && state.health.waitingResults > 0) ||
    (state.health.pendingJobs != null &&
      state.health.pendingJobs > 0 &&
      state.health.waitingPollers != null &&
      state.health.waitingPollers === 0)
  ) {
    return 'warn';
  }

  return 'ok';
}

async function refreshSimProxyHealth(config: SimProxyBridgeConfig): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${config.baseUrl}/health`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
        },
      },
      SIM_PROXY_STATUS_HEALTH_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`health 请求失败：${response.status}`);
    }

    const json = (await response.json()) as {
      ok?: unknown;
      data?: {
        status?: unknown;
        pendingJobs?: unknown;
        waitingResults?: unknown;
        waitingPollers?: unknown;
      };
    };

    const healthData = json.data;
    updateSimProxyHealth({
      ok: json.ok === true,
      status: healthData?.status === 'up' ? 'up' : 'unknown',
      pendingJobs: typeof healthData?.pendingJobs === 'number' ? Math.max(0, Math.round(healthData.pendingJobs)) : null,
      waitingResults:
        typeof healthData?.waitingResults === 'number' ? Math.max(0, Math.round(healthData.waitingResults)) : null,
      waitingPollers:
        typeof healthData?.waitingPollers === 'number' ? Math.max(0, Math.round(healthData.waitingPollers)) : null,
      lastCheckedAt: Date.now(),
      lastError: '',
    });
  } catch (error) {
    updateSimProxyHealth({
      ok: false,
      status: 'down',
      lastCheckedAt: Date.now(),
      lastError: toErrorMessage(error, 'health 检查失败'),
    });
  }
}

async function buildSimProxyBridgeStatusPayload(): Promise<SimProxyBridgeStatusPayload> {
  const [config, inFlightStore] = await Promise.all([getSimProxyBridgeConfig(), getSimProxyInFlightStore()]);
  const hasToken = config.token.trim().length > 0;

  if (isSimProxyBridgeEnabled(config)) {
    await refreshSimProxyHealth(config);
  } else {
    updateSimProxyHealth({
      ok: false,
      status: 'unknown',
      pendingJobs: null,
      waitingResults: null,
      waitingPollers: null,
      lastCheckedAt: Date.now(),
      lastError: hasToken ? '' : '未配置 BRIDGE_TOKEN',
    });
  }

  const baseState = {
    config: {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      hasToken,
    },
    health: simProxyRuntimeState.health,
    poll: {
      loopRunning: simProxyPollLoopRunning,
      lastPollAt: simProxyRuntimeState.poll.lastPollAt,
      lastPollOkAt: simProxyRuntimeState.poll.lastPollOkAt,
      lastPollError: simProxyRuntimeState.poll.lastPollError,
    },
    dispatch: {
      pendingResultCount: Math.max(simProxyPendingRequests.size, Object.keys(inFlightStore).length),
      lastJobId: simProxyRuntimeState.dispatch.lastJobId,
      lastOrigin: simProxyRuntimeState.dispatch.lastOrigin,
      lastDispatchAt: simProxyRuntimeState.dispatch.lastDispatchAt,
      lastDispatchError: simProxyRuntimeState.dispatch.lastDispatchError,
      executor: {
        sim: getExecutorHealthByKey('sim'),
        sem: getExecutorHealthByKey('sem'),
        failoverCount: simProxyFailoverState.count,
        lastFailoverAt: simProxyFailoverState.lastAt,
        lastFailoverReason: simProxyFailoverState.lastReason,
      },
    },
    result: {
      lastResultReceivedAt: simProxyRuntimeState.result.lastResultReceivedAt,
      lastResultPostedAt: simProxyRuntimeState.result.lastResultPostedAt,
      lastResultPostError: simProxyRuntimeState.result.lastResultPostError,
    },
  };

  const level = getSimProxyStatusLevel(baseState);

  const payload: SimProxyBridgeStatusPayload = {
    checkedAt: Date.now(),
    level,
    summary: '',
    ...baseState,
  };

  payload.summary = getSimProxyStatusSummary(level, payload);
  return payload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeHeaderRecord(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => [key.trim(), typeof value === 'string' ? value : String(value)] as const)
      .filter(([key]) => key.length > 0),
  );
}

function createBridgeHeaders(config: SimProxyBridgeConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.token}`,
    'x-extension-id': chrome.runtime.id,
  };
}

function isSimProxyBridgeEnabled(config: SimProxyBridgeConfig): boolean {
  return config.enabled && config.baseUrl.trim().length > 0 && config.token.trim().length > 0;
}

function isMissingReceiverError(error: unknown): boolean {
  const message = toErrorMessage(error, '').toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('receiving end does not exist') ||
    message.includes('could not establish connection') ||
    message.includes('message port closed before a response was received')
  );
}

function getResultPostRetryDelayMs(attempt: number): number {
  return SIM_PROXY_RESULT_POST_RETRY_BASE_DELAY_MS * Math.max(1, 2 ** attempt);
}

function getSimProxyInFlightExpiry(timeoutMs: number): number {
  return Date.now() + getSimProxyResultTimeoutMs(timeoutMs) + SIM_PROXY_RESULT_POST_TIMEOUT_MS + 30_000;
}

function toSimProxyInFlightRecord(job: SimProxyBridgeJob): SimProxyInFlightRecord {
  return {
    id: job.id,
    origin: job.origin,
    timeoutMs: job.timeoutMs,
    createdAt: Date.now(),
    expiresAt: getSimProxyInFlightExpiry(job.timeoutMs),
  };
}

type SimProxyInjectionScript = {
  file: string;
  world: chrome.scripting.ExecutionWorld;
};

function getSimProxyInjectionScripts(): SimProxyInjectionScript[] {
  const manifest = chrome.runtime.getManifest();
  const contentScripts = manifest.content_scripts ?? [];
  const scripts = contentScripts
    .flatMap((item) => {
      const matches = item.matches ?? [];
      const isSimProxyScript = matches.some((pattern) => pattern === 'https://sim.3ue.co/*' || pattern === 'https://sem.3ue.co/*');
      if (!isSimProxyScript || !Array.isArray(item.js)) {
        return [];
      }

      const itemWorld = (item as { world?: unknown }).world;
      const world = itemWorld === 'MAIN' ? chrome.scripting.ExecutionWorld.MAIN : chrome.scripting.ExecutionWorld.ISOLATED;
      return item.js
        .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
        .map((file) => ({
          file,
          world,
        }));
    })
    .filter((item) => item.file.includes('simProxyBridge') || item.file.includes('simProxyInjected'));

  const deduped = new Map<string, SimProxyInjectionScript>();
  for (const script of scripts) {
    deduped.set(`${script.file}::${script.world}`, script);
  }

  return [...deduped.values()];
}

async function ensureSimProxyBridgeScriptsInjected(tabId: number): Promise<void> {
  const scripts = getSimProxyInjectionScripts();
  if (scripts.length === 0) {
    throw new Error('未找到可注入的代理脚本配置');
  }

  for (const script of scripts) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [script.file],
      world: script.world,
    });
  }
}

async function sendSimProxyExecuteWithRecovery(tabId: number, payload: SimProxyExecutePayload): Promise<void> {
  await sendExecuteViaSendMessageFallback(tabId, payload);
}

async function syncSimProxyPollingAlarm(): Promise<void> {
  const config = await getSimProxyBridgeConfig();
  const alarm = await chrome.alarms.get(SIM_PROXY_POLL_ALARM);
  const shouldEnable = isSimProxyBridgeEnabled(config);

  if (shouldEnable && !alarm) {
    await chrome.alarms.create(SIM_PROXY_POLL_ALARM, {
      delayInMinutes: SIM_PROXY_POLL_ALARM_PERIOD_MINUTES,
      periodInMinutes: SIM_PROXY_POLL_ALARM_PERIOD_MINUTES,
    });
    return;
  }

  if (!shouldEnable && alarm) {
    await chrome.alarms.clear(SIM_PROXY_POLL_ALARM);
  }
}

function isSimProxyResultPayload(value: unknown): value is SimProxyResultPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<SimProxyResultPayload>;
  return (
    typeof payload.id === 'string' &&
    typeof payload.status === 'number' &&
    typeof payload.body === 'string' &&
    typeof payload.truncated === 'boolean' &&
    typeof payload.finalUrl === 'string' &&
    typeof payload.error === 'string' &&
    typeof payload.headers === 'object' &&
    payload.headers !== null
  );
}

function parseSimProxyBridgeJob(value: unknown): SimProxyBridgeJob | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const raw = value as {
    id?: unknown;
    method?: unknown;
    path?: unknown;
    headers?: unknown;
    body?: unknown;
    timeoutMs?: unknown;
    origin?: unknown;
  };

  if (typeof raw.id !== 'string' || typeof raw.method !== 'string' || typeof raw.path !== 'string') {
    return null;
  }

  const method = raw.method.trim().toUpperCase();
  if (!SIM_PROXY_ALLOWED_METHODS.has(method)) {
    return null;
  }

  const origin = typeof raw.origin === 'string' ? raw.origin.trim() : SIM_PROXY_DEFAULT_ALLOWED_ORIGIN;
  if (!SIM_PROXY_ALLOWED_ORIGINS.has(origin)) {
    return null;
  }

  const timeoutMs = Number.isFinite(raw.timeoutMs)
    ? Math.max(SIM_PROXY_MIN_TIMEOUT_MS, Math.min(SIM_PROXY_MAX_TIMEOUT_MS, Math.round(raw.timeoutMs as number)))
    : SIM_PROXY_DEFAULT_TIMEOUT_MS;

  return {
    id: raw.id,
    method,
    path: raw.path,
    headers: normalizeHeaderRecord(raw.headers),
    body: typeof raw.body === 'string' ? raw.body : raw.body == null ? '' : String(raw.body),
    timeoutMs,
    origin,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveSimProxyTabId(origin: string): Promise<number | null> {
  if (!SIM_PROXY_ALLOWED_ORIGINS.has(origin)) {
    return null;
  }

  const urlPattern = [`${origin}/*`];
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true, url: urlPattern });
  const activeTab = activeTabs.find((tab) => typeof tab.id === 'number');
  if (activeTab?.id != null) {
    return activeTab.id;
  }

  const fallbackTabs = await chrome.tabs.query({ url: urlPattern });
  const fallbackTab = fallbackTabs.find((tab) => typeof tab.id === 'number');
  return fallbackTab?.id ?? null;
}

function getSimProxyResultTimeoutMs(timeoutMs: number): number {
  const normalizedTimeoutMs = Math.max(
    SIM_PROXY_MIN_TIMEOUT_MS,
    Math.min(SIM_PROXY_MAX_TIMEOUT_MS, Math.round(timeoutMs)),
  );
  return normalizedTimeoutMs + SIM_PROXY_RESULT_TIMEOUT_BUFFER_MS;
}

function createPendingResultPromise(requestId: string, timeoutMs: number): Promise<SimProxyResultPayload> {
  return new Promise<SimProxyResultPayload>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      simProxyPendingRequests.delete(requestId);
      simProxyRequestExecutors.delete(requestId);
      clearDispatchAckWaiter(requestId);
      reject(new Error('等待页面响应超时'));
    }, getSimProxyResultTimeoutMs(timeoutMs));

    simProxyPendingRequests.set(requestId, { resolve, reject, timeoutId });
  });
}

function resolvePendingSimProxyResult(payload: SimProxyResultPayload): boolean {
  const pending = simProxyPendingRequests.get(payload.id);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeoutId);
  simProxyPendingRequests.delete(payload.id);
  simProxyRequestExecutors.delete(payload.id);
  clearDispatchAckWaiter(payload.id);
  pending.resolve(payload);
  return true;
}

function rejectPendingSimProxyResult(requestId: string, message: string): void {
  const pending = simProxyPendingRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  simProxyPendingRequests.delete(requestId);
  simProxyRequestExecutors.delete(requestId);
  clearDispatchAckWaiter(requestId);
  pending.reject(new Error(message));
}

async function dispatchSimProxyJobWithPort(session: SimProxyExecutorSession, payload: SimProxyExecutePayload): Promise<void> {
  const message: SimProxyPortOutboundMessage = {
    type: SIM_PROXY_PORT_EXECUTE,
    payload,
  };

  const ackPromise = waitForDispatchAck(payload.id, SIM_PROXY_DISPATCH_ACK_TIMEOUT_MS);

  try {
    session.port.postMessage(message);
  } catch (error) {
    clearDispatchAckWaiter(payload.id);
    throw error;
  }

  const ack = await ackPromise;
  if (!ack.accepted) {
    throw new Error(ack.error || '执行页未接受请求');
  }
}

async function executeSimProxyJob(job: SimProxyBridgeJob): Promise<SimProxyResultPayload> {
  simProxyRuntimeState.dispatch.lastJobId = job.id;
  simProxyRuntimeState.dispatch.lastOrigin = job.origin;
  simProxyRuntimeState.dispatch.lastDispatchAt = Date.now();
  simProxyRuntimeState.dispatch.lastDispatchError = '';

  const payload: SimProxyExecutePayload = {
    id: job.id,
    method: job.method,
    path: job.path,
    headers: job.headers,
    body: job.body,
    timeoutMs: job.timeoutMs,
    origin: job.origin,
  };

  const waitResult = createPendingResultPromise(job.id, job.timeoutMs);
  await upsertSimProxyInFlightRecord(toSimProxyInFlightRecord(job));

  const triedTabIds = new Set<number>();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await resolveExecutorSession(job.origin, triedTabIds.size > 0 ? triedTabIds : undefined);
    if (!session) {
      const fallbackTabId = await resolveSimProxyTabId(job.origin);
      if (fallbackTabId == null || triedTabIds.has(fallbackTabId)) {
        break;
      }

      triedTabIds.add(fallbackTabId);
      simProxyRequestExecutors.set(job.id, fallbackTabId);

      try {
        await sendSimProxyExecuteWithRecovery(fallbackTabId, payload);
        return waitResult;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          recordSimProxyFailover(`tab ${fallbackTabId} sendMessage 回退失败：${toErrorMessage(error, '未知错误')}`);
        }
        continue;
      }
    }

    triedTabIds.add(session.tabId);
    simProxyRequestExecutors.set(job.id, session.tabId);

    try {
      await dispatchSimProxyJobWithPort(session, payload);
      return waitResult;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        recordSimProxyFailover(`tab ${session.tabId} ACK 失败：${toErrorMessage(error, '未知错误')}`);
      }
    }
  }

  const message =
    lastError != null
      ? `发送执行请求到目标站点页面失败：${toErrorMessage(lastError, '执行页不可用')}，请确认页面已打开后重试。`
      : `未找到可用的 ${job.origin} 执行页面，请先打开并登录。`;
  simProxyRuntimeState.dispatch.lastDispatchError = message;
  rejectPendingSimProxyResult(job.id, message);
  await deleteSimProxyInFlightRecord(job.id);
  throw new Error(message);
}

async function handleSimProxyResultPayload(payload: SimProxyResultPayload): Promise<SimProxyResultAck> {
  simProxyRuntimeState.result.lastResultReceivedAt = Date.now();

  const resolved = resolvePendingSimProxyResult(payload);
  if (resolved) {
    return { accepted: true };
  }

  const inFlight = await getSimProxyInFlightRecord(payload.id);
  if (!inFlight) {
    return {
      accepted: false,
      retryable: false,
      reason: '请求已过期或不存在',
    };
  }

  const config = await getSimProxyBridgeConfig();
  if (!isSimProxyBridgeEnabled(config)) {
    return {
      accepted: false,
      retryable: true,
      reason: '代理配置尚未就绪',
    };
  }

  try {
    await postSimProxyBridgeResult(config, payload.id, { ok: true, payload });
    await deleteSimProxyInFlightRecord(payload.id);
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      retryable: true,
      reason: toErrorMessage(error, '结果回传失败'),
    };
  }
}
async function postSimProxyBridgeResult(
  config: SimProxyBridgeConfig,
  jobId: string,
  result:
    | { ok: true; payload: SimProxyResultPayload }
    | {
        ok: false;
        error: string;
      },
): Promise<void> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < SIM_PROXY_RESULT_POST_RETRY_LIMIT; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${config.baseUrl}/v1/extension/result`,
        {
          method: 'POST',
          headers: createBridgeHeaders(config),
          body: JSON.stringify({
            id: jobId,
            ...result,
          }),
        },
        SIM_PROXY_RESULT_POST_TIMEOUT_MS,
      );

      const raw = (await response.json().catch(() => ({}))) as {
        ok?: unknown;
        accepted?: unknown;
        retryable?: unknown;
        reason?: unknown;
        error?: unknown;
      };

      if (!response.ok) {
        const retryable = typeof raw.retryable === 'boolean' ? raw.retryable : response.status >= 500;
        const reason =
          typeof raw.reason === 'string'
            ? raw.reason
            : typeof raw.error === 'string'
              ? raw.error
              : `结果回传失败：${response.status}`;

        if (retryable && attempt < SIM_PROXY_RESULT_POST_RETRY_LIMIT - 1) {
          await sleep(getResultPostRetryDelayMs(attempt));
          continue;
        }

        throw new Error(reason);
      }

      if (raw.ok !== true || raw.accepted !== true) {
        const retryable = typeof raw.retryable === 'boolean' ? raw.retryable : true;
        const reason = typeof raw.reason === 'string' ? raw.reason : '本地服务未接受结果';

        if (retryable && attempt < SIM_PROXY_RESULT_POST_RETRY_LIMIT - 1) {
          await sleep(getResultPostRetryDelayMs(attempt));
          continue;
        }

        throw new Error(reason);
      }

      simProxyRuntimeState.result.lastResultPostedAt = Date.now();
      simProxyRuntimeState.result.lastResultPostError = '';
      return;
    } catch (error) {
      lastError = toErrorMessage(error, '结果回传失败');
      if (attempt < SIM_PROXY_RESULT_POST_RETRY_LIMIT - 1) {
        await sleep(getResultPostRetryDelayMs(attempt));
        continue;
      }
    }
  }

  simProxyRuntimeState.result.lastResultPostError = lastError || '结果回传失败';
  throw new Error(simProxyRuntimeState.result.lastResultPostError);
}

async function pollSimProxyBridgeJob(config: SimProxyBridgeConfig, maxWaitMs = SIM_PROXY_POLL_MAX_WAIT_MS): Promise<SimProxyBridgeJob | null> {
  simProxyRuntimeState.poll.lastPollAt = Date.now();

  const response = await fetchWithTimeout(
    `${config.baseUrl}/v1/extension/poll`,
    {
      method: 'POST',
      headers: createBridgeHeaders(config),
      body: JSON.stringify({
        maxWaitMs,
      }),
    },
    SIM_PROXY_POLL_REQUEST_TIMEOUT_MS,
  );

  if (response.status === 204) {
    simProxyRuntimeState.poll.lastPollOkAt = Date.now();
    simProxyRuntimeState.poll.lastPollError = '';
    return null;
  }

  if (!response.ok) {
    throw new Error(`本地服务轮询失败：${response.status}`);
  }

  const json = (await response.json()) as unknown;
  const parsed = parseSimProxyBridgeJob(json);
  if (!parsed) {
    throw new Error('本地服务返回了无效任务');
  }

  simProxyRuntimeState.poll.lastPollOkAt = Date.now();
  simProxyRuntimeState.poll.lastPollError = '';
  return parsed;
}

async function processSimProxyJob(config: SimProxyBridgeConfig, job: SimProxyBridgeJob): Promise<void> {
  let bridgeResult:
    | { ok: true; payload: SimProxyResultPayload }
    | {
        ok: false;
        error: string;
      };

  try {
    const payload = await executeSimProxyJob(job);
    bridgeResult = { ok: true, payload };
  } catch (error) {
    bridgeResult = {
      ok: false,
      error: error instanceof Error ? error.message : '本地接口代理执行失败',
    };
  }

  try {
    await postSimProxyBridgeResult(config, job.id, bridgeResult);
  } finally {
    await deleteSimProxyInFlightRecord(job.id);
  }
}

async function forceWakeupSimProxyPolling(): Promise<SimProxyBridgeStatusPayload> {
  const config = await getSimProxyBridgeConfig();
  if (!isSimProxyBridgeEnabled(config)) {
    throw new Error('代理配置未启用，请先填写并保存 baseUrl/token。');
  }

  await syncSimProxyPollingAlarm();
  ensureSimProxyPolling();
  await sleep(300);
  return buildSimProxyBridgeStatusPayload();
}

async function runSimProxyPollLoop(): Promise<void> {
  if (simProxyPollLoopRunning) {
    return;
  }

  simProxyPollLoopRunning = true;

  try {
    while (simProxyPollLoopRunning) {
      try {
        const config = await getSimProxyBridgeConfig();
        if (!isSimProxyBridgeEnabled(config)) {
          await sleep(SIM_PROXY_RETRY_DELAY_MS);
          continue;
        }

        const job = await pollSimProxyBridgeJob(config);
        if (!job) {
          continue;
        }

        await processSimProxyJob(config, job);
      } catch (error) {
        simProxyRuntimeState.poll.lastPollError = toErrorMessage(error, '轮询本地服务失败');
        await sleep(SIM_PROXY_RETRY_DELAY_MS);
      }
    }
  } finally {
    simProxyPollLoopRunning = false;
  }
}

function ensureSimProxyPolling(): void {
  void syncSimProxyPollingAlarm();
  void runSimProxyPollLoop();
  scheduleSimProxyExecutorMaintenance();
}

async function syncActionState(enabled: boolean) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1e8e3e' : '#8b1e1e' });
  await chrome.action.setTitle({ title: enabled ? '浮窗：已开启' : '浮窗：已关闭' });
}

async function syncActionStateFromStorage() {
  const enabled = await getPanelEnabled();
  await syncActionState(enabled);
}

function toCaptureSummary(record: CaptureRecord): CaptureRecordSummary {
  return {
    id: record.id,
    source: record.source,
    timestamp: record.timestamp,
    url: record.url,
    method: record.method,
    status: record.status,
    contentType: record.contentType,
    responseLength: record.responseBody.length,
    responseTruncated: record.responseTruncated,
    error: record.error,
  };
}

function createCaptureId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function syncCaptureStateFromStorage() {
  const [storedState, storedRecords, storedRule] = await Promise.all([
    getCaptureRuntimeState(),
    getCaptureRecords(),
    getCaptureRule(),
  ]);

  captureRecords = storedRecords;
  captureState = {
    ...storedState,
    rule: storedState.rule || storedRule,
    capturedCount: storedRecords.length,
    recent: storedRecords.slice(-20).reverse().map((record) => toCaptureSummary(record)),
  };

  if (captureState.rule) {
    try {
      captureMatcher = compileCaptureMatcher(captureState.rule);
    } catch {
      captureMatcher = null;
    }
  } else {
    captureMatcher = null;
  }

  if (captureState.isRecording) {
    captureState = {
      ...captureState,
      isRecording: false,
      tabId: null,
      stoppedAt: Date.now(),
      lastError: '扩展后台已重启，请重新开始录制。',
    };
  }

  await setCaptureRuntimeState(captureState);
}

function getCaptureStatePayload(): CaptureStatePayload {
  return {
    state: captureState,
  };
}

async function readNotionPayload(): Promise<NotionCachePayload> {
  const [cache, syncState] = await Promise.all([getNotionCache(), getNotionSyncState()]);
  return { cache, syncState };
}

async function syncNotionDatabase(): Promise<NotionCachePayload> {
  if (notionSyncInFlight) {
    return notionSyncInFlight;
  }

  notionSyncInFlight = (async () => {
    const config = await getNotionConfig();
    const lastState = await getNotionSyncState();
    const attemptAt = Date.now();

    await setNotionSyncState({
      ...lastState,
      isSyncing: true,
      lastAttemptAt: attemptAt,
      lastError: '',
    });

    try {
      const cache = await fetchNotionDatabase(config, attemptAt);
      const syncState = {
        isSyncing: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        lastError: '',
      };

      await Promise.all([setNotionCache(cache), setNotionSyncState(syncState)]);
      return { cache, syncState };
    } catch (error) {
      const currentCache = await getNotionCache();
      const syncState = {
        isSyncing: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: lastState.lastSuccessAt,
        lastError: getNotionErrorMessage(error),
      };

      await setNotionSyncState(syncState);
      return { cache: currentCache, syncState };
    } finally {
      notionSyncInFlight = null;
    }
  })();

  return notionSyncInFlight;
}

async function mutateNotionRecord(
  action: 'create' | 'update',
  values: NotionFormValues,
  recordId?: string,
): Promise<NotionCachePayload> {
  const config = await getNotionConfig();

  if (action === 'create') {
    await createNotionRecord(config, values);
  } else {
    await updateNotionRecord(config, recordId ?? '', values);
  }

  return syncNotionDatabase();
}

async function resolveTabId(preferredTabId?: number): Promise<number | null> {
  if (typeof preferredTabId === 'number') {
    return preferredTabId;
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = activeTabs.find((tab) => typeof tab.id === 'number');
  return activeTab?.id ?? null;
}

async function startCapture(rule: string, preferredTabId?: number): Promise<CaptureRuntimeState> {
  const normalizedRule = rule.trim();
  captureMatcher = compileCaptureMatcher(normalizedRule);

  const tabId = await resolveTabId(preferredTabId);
  const now = Date.now();

  captureRecords = [];
  captureState = {
    ...DEFAULT_CAPTURE_RUNTIME_STATE,
    isRecording: true,
    rule: normalizedRule,
    tabId,
    startedAt: now,
  };

  await Promise.all([setCaptureRule(normalizedRule), setCaptureRuntimeState(captureState), clearCaptureRecords()]);
  return captureState;
}

async function stopCapture(): Promise<CaptureRuntimeState> {
  if (!captureState.isRecording) {
    return captureState;
  }

  captureState = {
    ...captureState,
    isRecording: false,
    stoppedAt: Date.now(),
    tabId: null,
  };

  await setCaptureRuntimeState(captureState);
  return captureState;
}

async function clearCapture(): Promise<CaptureRuntimeState> {
  const preservedRule = captureState.rule;
  captureRecords = [];
  captureState = {
    ...DEFAULT_CAPTURE_RUNTIME_STATE,
    rule: preservedRule,
  };

  await Promise.all([setCaptureRuntimeState(captureState), clearCaptureRecords()]);
  return captureState;
}

async function appendCapture(payload: CaptureAppendPayload, senderTabId: number | null): Promise<CaptureRuntimeState> {
  if (!captureState.isRecording) {
    return captureState;
  }

  if (typeof captureState.tabId === 'number' && typeof senderTabId === 'number' && captureState.tabId !== senderTabId) {
    return captureState;
  }

  if (!captureState.rule) {
    captureMatcher = null;
    return captureState;
  }

  if (!captureMatcher || captureMatcher.raw !== captureState.rule) {
    try {
      captureMatcher = compileCaptureMatcher(captureState.rule);
    } catch (error) {
      captureState = {
        ...captureState,
        lastError: error instanceof Error ? error.message : '录制规则无效',
      };
      await setCaptureRuntimeState(captureState);
      return captureState;
    }
  }

  const matched = isCaptureUrlMatched(payload.url, captureMatcher);

  if (!matched) {
    return captureState;
  }

  if (captureRecords.length >= MAX_CAPTURE_RECORDS) {
    captureState = {
      ...captureState,
      droppedCount: captureState.droppedCount + 1,
      lastError: `已达到最大录制条数（${MAX_CAPTURE_RECORDS}）`,
    };
    await setCaptureRuntimeState(captureState);
    return captureState;
  }

  const nextChars = payload.requestBody.length + payload.responseBody.length;
  if (captureState.totalChars + nextChars > MAX_CAPTURE_TOTAL_CHARS) {
    captureState = {
      ...captureState,
      droppedCount: captureState.droppedCount + 1,
      lastError: '录制内容过大，已自动丢弃后续数据。请先下载并清空。',
    };
    await setCaptureRuntimeState(captureState);
    return captureState;
  }

  const record: CaptureRecord = {
    id: createCaptureId(),
    source: payload.source,
    timestamp: payload.timestamp,
    url: payload.url,
    method: payload.method.toUpperCase() || 'GET',
    status: payload.status,
    contentType: payload.contentType,
    requestBody: payload.requestBody,
    responseBody: payload.responseBody,
    responseEncoding: payload.responseEncoding,
    responseTruncated: payload.responseTruncated,
    requestHeaders: payload.requestHeaders,
    responseHeaders: payload.responseHeaders,
    error: payload.error,
  };

  captureRecords = [...captureRecords, record];

  captureState = {
    ...captureState,
    capturedCount: captureRecords.length,
    totalChars: captureState.totalChars + nextChars,
    lastError: '',
    recent: [toCaptureSummary(record), ...captureState.recent].slice(0, 20),
  };

  await Promise.all([setCaptureRuntimeState(captureState), setCaptureRecords(captureRecords)]);
  return captureState;
}

function buildEndpointSummary(records: CaptureRecord[]) {
  const grouped = new Map<
    string,
    {
      count: number;
      methods: Set<string>;
      statuses: Set<number>;
      latestAt: number;
      sampleRecordIds: string[];
    }
  >();

  for (const record of records) {
    let endpoint = record.url;
    try {
      const parsed = new URL(record.url);
      endpoint = `${parsed.origin}${parsed.pathname}`;
    } catch {
      // keep raw url
    }

    const existing = grouped.get(endpoint) ?? {
      count: 0,
      methods: new Set<string>(),
      statuses: new Set<number>(),
      latestAt: 0,
      sampleRecordIds: [],
    };

    existing.count += 1;
    existing.methods.add(record.method);
    existing.statuses.add(record.status);
    existing.latestAt = Math.max(existing.latestAt, record.timestamp);
    if (existing.sampleRecordIds.length < 5) {
      existing.sampleRecordIds.push(record.id);
    }

    grouped.set(endpoint, existing);
  }

  return [...grouped.entries()].map(([endpoint, item]) => ({
    endpoint,
    count: item.count,
    methods: [...item.methods],
    statuses: [...item.statuses].sort((a, b) => a - b),
    latestAt: item.latestAt,
    sampleRecordIds: item.sampleRecordIds,
  }));
}

function toSafeFileStamp(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const min = `${date.getMinutes()}`.padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function toSafeFileSegment(rule: string): string {
  const lines = rule
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidate = lines.find((line) => !line.startsWith('!')) ?? lines[0] ?? 'capture';

  let normalized = candidate.startsWith('!') ? candidate.slice(1).trim() : candidate;
  if (normalized.startsWith('/')) {
    const lastSlashIndex = normalized.lastIndexOf('/');
    if (lastSlashIndex > 0) {
      normalized = normalized.slice(1, lastSlashIndex);
    }
  }

  const safe = normalized
    .replace(/\s+/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);

  return safe || 'capture';
}

function toBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function dedupeCaptureRecords(records: CaptureRecord[]) {
  const deduped = new Map<
    string,
    {
      record: CaptureRecord;
      duplicateCount: number;
      duplicateRecordIds: string[];
    }
  >();

  for (const record of records) {
    const key = record.responseBody;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, {
        record,
        duplicateCount: 1,
        duplicateRecordIds: [record.id],
      });
      continue;
    }

    existing.duplicateCount += 1;
    existing.duplicateRecordIds.push(record.id);
  }

  return [...deduped.values()];
}

async function exportCapture(): Promise<CaptureExportPayload> {
  if (captureRecords.length === 0) {
    throw new Error('当前没有可下载的录制数据');
  }

  const now = Date.now();
  const deduped = dedupeCaptureRecords(captureRecords);
  const dedupedRecords = deduped.map((item) => item.record);
  const endpointSummary = buildEndpointSummary(dedupedRecords);
  const body = {
    meta: {
      exportedAt: now,
      rule: captureState.rule,
      startedAt: captureState.startedAt,
      stoppedAt: captureState.stoppedAt,
      capturedCount: captureState.capturedCount,
      dedupedCount: dedupedRecords.length,
      duplicateCollapsedCount: captureRecords.length - dedupedRecords.length,
      droppedCount: captureState.droppedCount,
      totalChars: captureState.totalChars,
    },
    records: deduped.map((item) => ({
      ...item.record,
      duplicateCount: item.duplicateCount,
      duplicateRecordIds: item.duplicateRecordIds,
    })),
    grouped: endpointSummary,
    ai_hint: [
      '你是接口分析助手。',
      '请先按 grouped 中 count 排序，找出调用最频繁的 endpoint。',
      '总结每个 endpoint 的请求结构（requestBody）与返回结构（responseBody）。',
      '识别状态码异常、字段缺失、空值比例高的接口。',
      '检查疑似敏感字段（token、cookie、email、phone、id_card）。',
      '最终输出：接口清单、异常清单、建议修复项。',
    ].join('\n'),
  };

  const serialized = JSON.stringify(body, null, 2);
  const fileName = `${toSafeFileSegment(captureState.rule)}-${toSafeFileStamp(now)}.json`;
  const dataUrl = `data:application/json;charset=utf-8;base64,${toBase64Utf8(serialized)}`;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: true,
    conflictAction: 'uniquify',
  });

  if (typeof downloadId !== 'number') {
    throw new Error('下载失败，请检查浏览器下载权限。');
  }

  captureState = {
    ...captureState,
    lastExportAt: now,
  };
  await setCaptureRuntimeState(captureState);

  return {
    fileName,
    downloadId,
    count: dedupedRecords.length,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void syncActionStateFromStorage();
  void setNotionSyncState(DEFAULT_NOTION_SYNC_STATE);
  void setCaptureRuntimeState(DEFAULT_CAPTURE_RUNTIME_STATE);
  void clearCaptureRecords();
  void setCaptureRule('');
  ensureSimProxyPolling();
});

chrome.runtime.onStartup.addListener(() => {
  void syncActionStateFromStorage();
  void syncCaptureStateFromStorage();
  ensureSimProxyPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SIM_PROXY_POLL_ALARM) {
    return;
  }

  ensureSimProxyPolling();
});


chrome.runtime.onConnect.addListener((port) => {
  registerSimProxyPort(port);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeExecutorSession(tabId, `tab ${tabId} 已关闭`);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const session = simProxyExecutorSessions.get(tabId);
  if (!session) {
    return;
  }

  const nextUrl = typeof changeInfo.url === 'string' ? changeInfo.url : tab.url;
  if (typeof nextUrl !== 'string' || nextUrl.length === 0) {
    return;
  }

  const nextOrigin = toTabOrigin(nextUrl);
  if (!nextOrigin || !isKnownSimProxyOrigin(nextOrigin)) {
    removeExecutorSession(tabId, `tab ${tabId} 已离开目标站点`);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if ('panelEnabled' in changes) {
    const next = changes.panelEnabled?.newValue;
    if (typeof next === 'boolean') {
      void syncActionState(next);
    }
  }

  if ('simProxyBridgeConfig' in changes) {
    ensureSimProxyPolling();
    void (async () => {
      const config = await getSimProxyBridgeConfig();
      if (config.autoMaintainExecutors) {
        scheduleSimProxyExecutorMaintenance();
      } else {
        stopSimProxyExecutorMaintenance();
      }
    })();
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return undefined;
  }
  const isNotionRequest =
    type === GET_NOTION_CACHE ||
    type === SYNC_NOTION_DATABASE ||
    type === CREATE_NOTION_RECORD ||
    type === UPDATE_NOTION_RECORD;

  const isCaptureRequest =
    type === CAPTURE_GET_STATE ||
    type === CAPTURE_START ||
    type === CAPTURE_STOP ||
    type === CAPTURE_CLEAR ||
    type === CAPTURE_EXPORT ||
    type === CAPTURE_APPEND;

  const isSimProxyRequest =
    type === SIM_PROXY_EXECUTE || type === SIM_PROXY_RESULT || type === SIM_PROXY_STATUS || type === SIM_PROXY_WAKEUP;

  const isNativeHostRequest = type === NATIVE_HOST_STATUS || type === NATIVE_HOST_START || type === NATIVE_HOST_STOP;

  if (!isNotionRequest && !isCaptureRequest && !isSimProxyRequest && !isNativeHostRequest) {
    return undefined;
  }

  void (async () => {
    try {
      if (isNotionRequest) {
        const request = message as Partial<NotionBackgroundRequest>;
        const createValues = 'values' in request && request.values ? request.values : {};
        const updateValues = 'values' in request && request.values ? request.values : {};
        const updateRecordId = 'recordId' in request && typeof request.recordId === 'string' ? request.recordId : '';

        const data =
          request.type === GET_NOTION_CACHE
            ? await readNotionPayload()
            : request.type === SYNC_NOTION_DATABASE
              ? await syncNotionDatabase()
              : request.type === CREATE_NOTION_RECORD
                ? await mutateNotionRecord('create', createValues)
                : await mutateNotionRecord('update', updateValues, updateRecordId);

        const response: NotionBackgroundResponse = { ok: true, data };
        sendResponse(response);
        return;
      }

      if (isNativeHostRequest) {
        const request = message as Partial<NativeHostBackgroundRequest>;

        let command: NativeHostControlRequest;
        if (request.type === NATIVE_HOST_START) {
          const config = await getSimProxyBridgeConfig();
          const requestToken = typeof request.token === 'string' ? request.token.trim() : '';
          const token = requestToken || config.token.trim();
          command = {
            command: 'start',
            port: DEFAULT_SIM_PROXY_PORT,
            token,
          };
        } else if (request.type === NATIVE_HOST_STOP) {
          command = { command: 'stop' };
        } else {
          command = { command: 'status' };
        }

        const state = await requestNativeHost(command);

        if (request.type === NATIVE_HOST_START) {
          const checkedState = await requestNativeHost({ command: 'status' });
          if (!checkedState.running) {
            throw createNativeHostError(
              'SERVICE_STARTUP_FAILED',
              '本地服务启动后未保持运行，请检查端口占用或查看日志。',
              'start',
              undefined,
              '日志文件：~/.hacker-extension-native/bridge.log',
            );
          }

          await syncSimProxyConfigFromNativeState(checkedState);
          ensureSimProxyPolling();
          scheduleSimProxyExecutorMaintenance();

          const response: NativeHostBackgroundResponse = {
            ok: true,
            data: { state: checkedState },
          };
          sendResponse(response);
          return;
        }

        if (request.type === NATIVE_HOST_STOP) {
          const checkedState = await requestNativeHost({ command: 'status' });
          if (checkedState.running) {
            throw createNativeHostError(
              'STOP_FAILED',
              '停止后本地服务仍在运行，请重试或手动结束进程。',
              'stop',
            );
          }

          const response: NativeHostBackgroundResponse = {
            ok: true,
            data: { state: checkedState },
          };
          sendResponse(response);
          return;
        }

        const response: NativeHostBackgroundResponse = {
          ok: true,
          data: { state },
        };
        sendResponse(response);
        return;
      }

      if (isSimProxyRequest) {
        const request = message as Partial<SimProxyBackgroundRequest>;

        if (request.type === SIM_PROXY_WAKEUP) {
          const payload = await forceWakeupSimProxyPolling();
          const response: SimProxyBackgroundResponse<SimProxyBridgeStatusPayload> = {
            ok: true,
            data: payload,
          };
          sendResponse(response);
          return;
        }

        if (request.type === SIM_PROXY_STATUS) {
          const statusPayload = await buildSimProxyBridgeStatusPayload();
          const response: SimProxyBackgroundResponse<SimProxyBridgeStatusPayload> = {
            ok: true,
            data: statusPayload,
          };
          sendResponse(response);
          return;
        }

        if (request.type === SIM_PROXY_RESULT) {
          const payload = request.payload;
          if (!payload || !isSimProxyResultPayload(payload)) {
            throw new Error('本地接口代理响应数据无效');
          }

          const ack = await handleSimProxyResultPayload(payload);
          const response: SimProxyBackgroundResponse<SimProxyResultAck> = {
            ok: true,
            data: ack,
          };
          sendResponse(response);
          return;
        }

        sendResponse(createSimProxyFailure('本地接口代理消息类型无效'));
        return;
      }


      const request = message as Partial<CaptureBackgroundRequest>;
      if (request.type === CAPTURE_GET_STATE) {
        sendResponse({ ok: true, data: getCaptureStatePayload() });
        return;
      }

      if (request.type === CAPTURE_START) {
        const nextRule = typeof request.rule === 'string' ? request.rule : '';
        const nextTabId = typeof request.tabId === 'number' ? request.tabId : sender.tab?.id;
        const state = await startCapture(nextRule, nextTabId);
        sendResponse({ ok: true, data: { state } satisfies CaptureStatePayload });
        return;
      }

      if (request.type === CAPTURE_STOP) {
        const state = await stopCapture();
        sendResponse({ ok: true, data: { state } satisfies CaptureStatePayload });
        return;
      }

      if (request.type === CAPTURE_CLEAR) {
        const state = await clearCapture();
        sendResponse({ ok: true, data: { state } satisfies CaptureStatePayload });
        return;
      }

      if (request.type === CAPTURE_EXPORT) {
        const data = await exportCapture();
        sendResponse({ ok: true, data });
        return;
      }

      const payload = request.type === CAPTURE_APPEND ? request.payload : null;
      if (!payload) {
        throw new Error('录制数据为空');
      }

      const state = await appendCapture(payload, sender.tab?.id ?? null);
      sendResponse({ ok: true, data: { state } satisfies CaptureStatePayload });
    } catch (error) {
      if (isNotionRequest) {
        sendResponse(createNotionFailure(error));
      } else if (isNativeHostRequest) {
        const request = message as Partial<NativeHostBackgroundRequest>;
        const action: NativeHostAction =
          request.type === NATIVE_HOST_START ? 'start' : request.type === NATIVE_HOST_STOP ? 'stop' : 'status';
        sendResponse(createNativeHostFailure(error, action));
      } else if (isSimProxyRequest) {
        sendResponse(createSimProxyFailure(error));
      } else {
        sendResponse(createCaptureFailure(error));
      }
    }
  })();

  return true;
});

void syncActionStateFromStorage();
void syncCaptureStateFromStorage();
ensureSimProxyPolling();
