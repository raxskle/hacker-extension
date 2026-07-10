import {
  SIM_PROXY_BRIDGE_SOURCE,
  SIM_PROXY_EXECUTE,
  SIM_PROXY_PORT_DISPATCH_ACK,
  SIM_PROXY_PORT_EXECUTE,
  SIM_PROXY_PORT_HEARTBEAT,
  SIM_PROXY_PORT_HELLO,
  SIM_PROXY_PORT_NAME,
  SIM_PROXY_PORT_RESULT,
  SIM_PROXY_WINDOW_EXECUTE,
  SIM_PROXY_WINDOW_RESULT,
  requestSimProxyResult,
  type SimProxyBackgroundRequest,
  type SimProxyExecutePayload,
  type SimProxyResultAck,
  type SimProxyResultPayload,
  type SimProxyWindowExecuteMessage,
} from '../shared/simProxy';

const ALLOWED_ORIGINS = new Set(['https://sim.3ue.co', 'https://sem.3ue.co']);
const pendingRequestIds = new Set<string>();
const RESULT_POST_RETRY_LIMIT = 3;
const RESULT_POST_RETRY_BASE_DELAY_MS = 300;
const PORT_HEARTBEAT_INTERVAL_MS = 5_000;
const PORT_RECONNECT_BASE_DELAY_MS = 500;
const PORT_RECONNECT_MAX_DELAY_MS = 8_000;
const isTopFrame = window.top === window.self;

const bridgeWindow = window as Window & {
  __HACKER_EXTENSION_SIM_PROXY_BRIDGE_READY__?: boolean;
};

let simProxyPort: chrome.runtime.Port | null = null;
let reconnectTimerId: number | null = null;
let reconnectAttempt = 0;
let heartbeatTimerId: number | null = null;

function isHeaderRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
  );
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
    typeof payload.body === 'string' &&
    typeof payload.timeoutMs === 'number' &&
    (payload.origin == null || typeof payload.origin === 'string') &&
    isHeaderRecord(payload.headers)
  );
}

function isResultPayload(value: unknown): value is SimProxyResultPayload {
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
    isHeaderRecord(payload.headers)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRetryDelayMs(attempt: number): number {
  return RESULT_POST_RETRY_BASE_DELAY_MS * Math.max(1, 2 ** attempt);
}

function shouldRetryResult(ack: SimProxyResultAck): boolean {
  if (ack.accepted) {
    return false;
  }

  return ack.retryable !== false;
}

function getCurrentPageOrigin(): string {
  return window.location.origin;
}

function isAllowedPageOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin);
}

function stopHeartbeat(): void {
  if (heartbeatTimerId == null) {
    return;
  }

  window.clearInterval(heartbeatTimerId);
  heartbeatTimerId = null;
}

function sendPortHello(port: chrome.runtime.Port): void {
  const origin = getCurrentPageOrigin();
  if (!isAllowedPageOrigin(origin)) {
    return;
  }

  port.postMessage({
    type: SIM_PROXY_PORT_HELLO,
    origin,
    pageUrl: window.location.href,
  });
}

function sendPortHeartbeat(port: chrome.runtime.Port): void {
  const origin = getCurrentPageOrigin();
  if (!isAllowedPageOrigin(origin)) {
    return;
  }

  port.postMessage({
    type: SIM_PROXY_PORT_HEARTBEAT,
    origin,
    pageUrl: window.location.href,
    sentAt: Date.now(),
  });
}

function startHeartbeat(port: chrome.runtime.Port): void {
  stopHeartbeat();
  heartbeatTimerId = window.setInterval(() => {
    try {
      sendPortHeartbeat(port);
    } catch {
      // wait reconnect flow on disconnect
    }
  }, PORT_HEARTBEAT_INTERVAL_MS);
}

function getReconnectDelayMs(attempt: number): number {
  const raw = PORT_RECONNECT_BASE_DELAY_MS * Math.max(1, 2 ** attempt);
  return Math.min(PORT_RECONNECT_MAX_DELAY_MS, raw);
}

function schedulePortReconnect(): void {
  if (reconnectTimerId != null) {
    return;
  }

  const delay = getReconnectDelayMs(reconnectAttempt);
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null;
    connectSimProxyPort();
  }, delay);
  reconnectAttempt += 1;
}

function clearReconnectTimer(): void {
  if (reconnectTimerId == null) {
    return;
  }

  window.clearTimeout(reconnectTimerId);
  reconnectTimerId = null;
}

function sendDispatchAck(port: chrome.runtime.Port | null, payload: { id: string; accepted: boolean; error?: string }): void {
  if (!port) {
    return;
  }

  try {
    port.postMessage({
      type: SIM_PROXY_PORT_DISPATCH_ACK,
      id: payload.id,
      accepted: payload.accepted,
      error: payload.error,
    });
  } catch {
    // background will timeout and failover
  }
}

function enqueueExecution(payload: SimProxyExecutePayload): void {
  pendingRequestIds.add(payload.id);

  const executeMessage: SimProxyWindowExecuteMessage = {
    source: SIM_PROXY_BRIDGE_SOURCE,
    type: SIM_PROXY_WINDOW_EXECUTE,
    payload,
  };

  window.postMessage(executeMessage, '*');
}

function handlePortExecute(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    return;
  }

  const message = raw as { type?: unknown; payload?: unknown };
  if (message.type !== SIM_PROXY_PORT_EXECUTE) {
    return;
  }

  const maybeId =
    typeof message.payload === 'object' && message.payload !== null && typeof (message.payload as { id?: unknown }).id === 'string'
      ? ((message.payload as { id: string }).id as string)
      : '';

  if (!isExecutePayload(message.payload)) {
    if (maybeId) {
      sendDispatchAck(simProxyPort, { id: maybeId, accepted: false, error: '执行请求数据无效' });
    }
    return;
  }

  enqueueExecution(message.payload);
  sendDispatchAck(simProxyPort, { id: message.payload.id, accepted: true });
}

function connectSimProxyPort(): void {
  if (!isTopFrame) {
    return;
  }

  const origin = getCurrentPageOrigin();
  if (!isAllowedPageOrigin(origin)) {
    return;
  }

  if (simProxyPort) {
    return;
  }

  try {
    const port = chrome.runtime.connect({ name: SIM_PROXY_PORT_NAME });
    simProxyPort = port;
    reconnectAttempt = 0;
    clearReconnectTimer();

    port.onMessage.addListener((message: unknown) => {
      handlePortExecute(message);
    });

    port.onDisconnect.addListener(() => {
      if (simProxyPort === port) {
        simProxyPort = null;
      }

      stopHeartbeat();
      schedulePortReconnect();
    });

    sendPortHello(port);
    sendPortHeartbeat(port);
    startHeartbeat(port);
  } catch {
    simProxyPort = null;
    schedulePortReconnect();
  }
}

async function reportSimProxyResultWithRetry(payload: SimProxyResultPayload): Promise<void> {
  let shouldKeepRetrying = true;

  try {
    for (let attempt = 0; attempt < RESULT_POST_RETRY_LIMIT && shouldKeepRetrying; attempt += 1) {
      try {
        const ack = await requestSimProxyResult(payload);
        if (ack.accepted) {
          return;
        }

        shouldKeepRetrying = shouldRetryResult(ack);
      } catch {
        // continue retrying
      }

      if (shouldKeepRetrying && attempt < RESULT_POST_RETRY_LIMIT - 1) {
        await sleep(getRetryDelayMs(attempt));
      }
    }
  } finally {
    pendingRequestIds.delete(payload.id);
  }
}

async function publishResult(payload: SimProxyResultPayload): Promise<void> {
  if (simProxyPort) {
    try {
      simProxyPort.postMessage({
        type: SIM_PROXY_PORT_RESULT,
        payload,
      });
      pendingRequestIds.delete(payload.id);
      return;
    } catch {
      // fallback below
    }
  }

  await reportSimProxyResultWithRetry(payload);
}

if (isTopFrame && !bridgeWindow.__HACKER_EXTENSION_SIM_PROXY_BRIDGE_READY__) {
  bridgeWindow.__HACKER_EXTENSION_SIM_PROXY_BRIDGE_READY__ = true;

  connectSimProxyPort();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return undefined;
    }

    const request = message as Partial<SimProxyBackgroundRequest>;
    if (request.type !== SIM_PROXY_EXECUTE || !request.payload || !isExecutePayload(request.payload)) {
      return undefined;
    }

    enqueueExecution(request.payload);
    sendResponse({ ok: true, data: { accepted: true } });
    return true;
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }

    if (typeof event.data !== 'object' || event.data === null) {
      return;
    }

    const data = event.data as { source?: unknown; type?: unknown; payload?: unknown };
    if (data.source !== SIM_PROXY_BRIDGE_SOURCE || data.type !== SIM_PROXY_WINDOW_RESULT || !isResultPayload(data.payload)) {
      return;
    }

    if (!pendingRequestIds.has(data.payload.id)) {
      return;
    }

    void publishResult(data.payload);
  });
}
