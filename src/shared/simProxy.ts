export const SIM_PROXY_EXECUTE = 'sim-proxy/execute';
export const SIM_PROXY_RESULT = 'sim-proxy/result';
export const SIM_PROXY_STATUS = 'sim-proxy/status';

export const SIM_PROXY_BRIDGE_SOURCE = 'hacker-extension-sim-proxy';
export const SIM_PROXY_WINDOW_EXECUTE = 'sim/execute';
export const SIM_PROXY_WINDOW_RESULT = 'sim/result';

export type SimProxyExecutePayload = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  origin?: string;
};

export type SimProxyResultPayload = {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  finalUrl: string;
  error: string;
};

export type SimProxyHealthStatus = 'up' | 'down' | 'unknown';
export type SimProxyStatusLevel = 'ok' | 'warn' | 'error';

export type SimProxyBridgeStatusPayload = {
  checkedAt: number;
  level: SimProxyStatusLevel;
  summary: string;
  config: {
    enabled: boolean;
    baseUrl: string;
    hasToken: boolean;
  };
  health: {
    ok: boolean;
    status: SimProxyHealthStatus;
    pendingJobs: number | null;
    waitingResults: number | null;
    waitingPollers: number | null;
    lastCheckedAt: number | null;
    lastError: string;
  };
  poll: {
    loopRunning: boolean;
    lastPollAt: number | null;
    lastPollOkAt: number | null;
    lastPollError: string;
  };
  dispatch: {
    pendingResultCount: number;
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
};

export type SimProxyWindowExecuteMessage = {
  source: typeof SIM_PROXY_BRIDGE_SOURCE;
  type: typeof SIM_PROXY_WINDOW_EXECUTE;
  payload: SimProxyExecutePayload;
};

export type SimProxyWindowResultMessage = {
  source: typeof SIM_PROXY_BRIDGE_SOURCE;
  type: typeof SIM_PROXY_WINDOW_RESULT;
  payload: SimProxyResultPayload;
};

type SimProxyExecuteRequest = {
  type: typeof SIM_PROXY_EXECUTE;
  payload: SimProxyExecutePayload;
};

type SimProxyResultRequest = {
  type: typeof SIM_PROXY_RESULT;
  payload: SimProxyResultPayload;
};

type SimProxyStatusRequest = {
  type: typeof SIM_PROXY_STATUS;
};

export type SimProxyBackgroundRequest = SimProxyExecuteRequest | SimProxyResultRequest | SimProxyStatusRequest;

type SimProxySuccess<T> = {
  ok: true;
  data: T;
};

type SimProxyFailure = {
  ok: false;
  error: string;
};

export type SimProxyBackgroundResponse<T = { accepted: boolean }> = SimProxySuccess<T> | SimProxyFailure;

function isSimProxyFailure(response: unknown): response is SimProxyFailure {
  return typeof response === 'object' && response !== null && 'ok' in response && (response as { ok: unknown }).ok === false;
}

async function requestSimProxyBackground<T>(request: SimProxyBackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as SimProxyBackgroundResponse<T> | undefined;

  if (!response) {
    throw new Error('扩展后台未响应，请刷新页面后重试。');
  }

  if (isSimProxyFailure(response)) {
    throw new Error(response.error);
  }

  return response.data;
}

export async function requestSimProxyResult(payload: SimProxyResultPayload): Promise<{ accepted: boolean }> {
  return requestSimProxyBackground<{ accepted: boolean }>({
    type: SIM_PROXY_RESULT,
    payload,
  });
}

export async function requestSimProxyStatus(): Promise<SimProxyBridgeStatusPayload> {
  return requestSimProxyBackground<SimProxyBridgeStatusPayload>({ type: SIM_PROXY_STATUS });
}

export function createSimProxyFailure(error: unknown): SimProxyBackgroundResponse {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '本地接口代理请求失败';
  return { ok: false, error: message };
}
