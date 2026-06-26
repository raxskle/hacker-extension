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

type CaptureMatcherRule = {
  raw: string;
  negate: boolean;
  mode: 'contains' | 'regex';
  regex?: RegExp;
};

export type CaptureMatcher = {
  raw: string;
  rules: CaptureMatcherRule[];
};

function isRegexFlags(value: string): boolean {
  return /^[dgimsuvy]*$/i.test(value);
}

function parseRuleItem(input: string, index: number): CaptureMatcherRule {
  const negate = input.startsWith('!');
  const raw = negate ? input.slice(1).trim() : input;

  if (!raw) {
    throw new Error(`第 ${index + 1} 条规则为空`);
  }

  if (raw.startsWith('/')) {
    const lastSlashIndex = raw.lastIndexOf('/');
    if (lastSlashIndex > 0) {
      const regexBody = raw.slice(1, lastSlashIndex);
      const regexFlags = raw.slice(lastSlashIndex + 1);

      if (isRegexFlags(regexFlags)) {
        try {
          return {
            raw,
            negate,
            mode: 'regex',
            regex: new RegExp(regexBody, regexFlags),
          };
        } catch (error) {
          throw new Error(`第 ${index + 1} 条正则无效：${error instanceof Error ? error.message : '格式错误'}`);
        }
      }
    }
  }

  return {
    raw,
    negate,
    mode: 'contains',
  };
}

function matchRule(url: string, rule: CaptureMatcherRule): boolean {
  if (rule.mode === 'regex') {
    return Boolean(rule.regex?.test(url));
  }

  return url.includes(rule.raw);
}

export function compileCaptureMatcher(rule: string): CaptureMatcher {
  const raw = rule.trim();
  if (!raw) {
    throw new Error('请输入 URL 过滤规则');
  }

  const parts = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error('请输入 URL 过滤规则');
  }

  return {
    raw,
    rules: parts.map((item, index) => parseRuleItem(item, index)),
  };
}

export function isCaptureUrlMatched(url: string, rule: string | CaptureMatcher): boolean {
  const matcher = typeof rule === 'string' ? compileCaptureMatcher(rule) : rule;
  const includeRules = matcher.rules.filter((item) => !item.negate);
  const excludeRules = matcher.rules.filter((item) => item.negate);

  const includeMatched = includeRules.length === 0 || includeRules.some((item) => matchRule(url, item));
  if (!includeMatched) {
    return false;
  }

  return !excludeRules.some((item) => matchRule(url, item));
}
