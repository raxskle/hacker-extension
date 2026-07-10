import {
  SIM_PROXY_BRIDGE_SOURCE,
  SIM_PROXY_EXECUTE,
  SIM_PROXY_WINDOW_EXECUTE,
  SIM_PROXY_WINDOW_RESULT,
  requestSimProxyResult,
  type SimProxyBackgroundRequest,
  type SimProxyExecutePayload,
  type SimProxyResultAck,
  type SimProxyResultPayload,
  type SimProxyWindowExecuteMessage,
} from '../shared/simProxy';

const pendingRequestIds = new Set<string>();
const RESULT_POST_RETRY_LIMIT = 3;
const RESULT_POST_RETRY_BASE_DELAY_MS = 300;
const isTopFrame = window.top === window.self;

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

if (isTopFrame) {
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

    void reportSimProxyResultWithRetry(data.payload);
  });
}
