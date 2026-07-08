import {
  SIM_PROXY_BRIDGE_SOURCE,
  SIM_PROXY_EXECUTE,
  SIM_PROXY_WINDOW_EXECUTE,
  SIM_PROXY_WINDOW_RESULT,
  requestSimProxyResult,
  type SimProxyBackgroundRequest,
  type SimProxyExecutePayload,
  type SimProxyResultPayload,
  type SimProxyWindowExecuteMessage,
} from '../shared/simProxy';

const pendingRequestIds = new Set<string>();

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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const request = message as Partial<SimProxyBackgroundRequest>;
  if (request.type !== SIM_PROXY_EXECUTE || !request.payload || !isExecutePayload(request.payload)) {
    return undefined;
  }

  pendingRequestIds.add(request.payload.id);

  const executeMessage: SimProxyWindowExecuteMessage = {
    source: SIM_PROXY_BRIDGE_SOURCE,
    type: SIM_PROXY_WINDOW_EXECUTE,
    payload: request.payload,
  };

  window.postMessage(executeMessage, '*');
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

  pendingRequestIds.delete(data.payload.id);

  void requestSimProxyResult(data.payload).catch(() => {
    // Ignore per-event bridge failures to avoid breaking host pages.
  });
});
