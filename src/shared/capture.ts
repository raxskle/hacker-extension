import type { CaptureRecord, CaptureRuntimeState } from './types';

export const CAPTURE_GET_STATE = 'capture/get-state';
export const CAPTURE_START = 'capture/start';
export const CAPTURE_STOP = 'capture/stop';
export const CAPTURE_CLEAR = 'capture/clear';
export const CAPTURE_EXPORT = 'capture/export';
export const CAPTURE_APPEND = 'capture/append';

export type CaptureAppendPayload = Omit<CaptureRecord, 'id'>;

export type CaptureStatePayload = {
  state: CaptureRuntimeState;
};

export type CaptureExportPayload = {
  fileName: string;
  downloadId: number;
  count: number;
};

type CaptureGetStateRequest = {
  type: typeof CAPTURE_GET_STATE;
};

type CaptureStartRequest = {
  type: typeof CAPTURE_START;
  rule: string;
  tabId?: number;
};

type CaptureStopRequest = {
  type: typeof CAPTURE_STOP;
};

type CaptureClearRequest = {
  type: typeof CAPTURE_CLEAR;
};

type CaptureExportRequest = {
  type: typeof CAPTURE_EXPORT;
};

type CaptureAppendRequest = {
  type: typeof CAPTURE_APPEND;
  payload: CaptureAppendPayload;
};

export type CaptureBackgroundRequest =
  | CaptureGetStateRequest
  | CaptureStartRequest
  | CaptureStopRequest
  | CaptureClearRequest
  | CaptureExportRequest
  | CaptureAppendRequest;

type CaptureSuccess<T> = {
  ok: true;
  data: T;
};

type CaptureFailure = {
  ok: false;
  error: string;
};

export type CaptureBackgroundResponse<T = CaptureStatePayload> = CaptureSuccess<T> | CaptureFailure;

function isCaptureFailure(response: unknown): response is CaptureFailure {
  return typeof response === 'object' && response !== null && 'ok' in response && (response as { ok: unknown }).ok === false;
}

async function requestCaptureBackground<T>(request: CaptureBackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as CaptureBackgroundResponse<T> | undefined;

  if (!response) {
    throw new Error('扩展后台未响应，请刷新页面后重试。');
  }

  if (isCaptureFailure(response)) {
    throw new Error(response.error);
  }

  return response.data;
}

export async function requestCaptureState(): Promise<CaptureStatePayload> {
  return requestCaptureBackground<CaptureStatePayload>({ type: CAPTURE_GET_STATE });
}

export async function requestCaptureStart(rule: string, tabId?: number): Promise<CaptureStatePayload> {
  return requestCaptureBackground<CaptureStatePayload>({ type: CAPTURE_START, rule, tabId });
}

export async function requestCaptureStop(): Promise<CaptureStatePayload> {
  return requestCaptureBackground<CaptureStatePayload>({ type: CAPTURE_STOP });
}

export async function requestCaptureClear(): Promise<CaptureStatePayload> {
  return requestCaptureBackground<CaptureStatePayload>({ type: CAPTURE_CLEAR });
}

export async function requestCaptureExport(): Promise<CaptureExportPayload> {
  return requestCaptureBackground<CaptureExportPayload>({ type: CAPTURE_EXPORT });
}

export async function requestCaptureAppend(payload: CaptureAppendPayload): Promise<CaptureStatePayload> {
  return requestCaptureBackground<CaptureStatePayload>({ type: CAPTURE_APPEND, payload });
}

export function createCaptureFailure(error: unknown): CaptureBackgroundResponse {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '录制请求失败';
  return { ok: false, error: message };
}

type CaptureMatcher = {
  raw: string;
  mode: 'contains' | 'regex';
  regex?: RegExp;
};

export function compileCaptureMatcher(rule: string): CaptureMatcher {
  const raw = rule.trim();
  if (!raw) {
    throw new Error('请输入 URL 过滤规则');
  }

  if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
    const body = raw.slice(1, -1);
    return {
      raw,
      mode: 'regex',
      regex: new RegExp(body),
    };
  }

  return {
    raw,
    mode: 'contains',
  };
}

export function isCaptureUrlMatched(url: string, rule: string): boolean {
  const matcher = compileCaptureMatcher(rule);
  if (matcher.mode === 'regex') {
    return Boolean(matcher.regex?.test(url));
  }
  return url.includes(matcher.raw);
}
