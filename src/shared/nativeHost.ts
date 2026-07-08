export const NATIVE_HOST_NAME = 'com.hacker_extension.bridge';

export const NATIVE_HOST_STATUS = 'native-host/status';
export const NATIVE_HOST_START = 'native-host/start';
export const NATIVE_HOST_STOP = 'native-host/stop';

export type NativeHostAction = 'start' | 'status' | 'stop';

export type NativeHostErrorCode =
  | 'INSTALL_MISSING'
  | 'NODE_MISSING'
  | 'HOST_EXITED'
  | 'PERMISSION_OR_PATH'
  | 'SERVICE_PATH_MISSING'
  | 'SERVICE_SPAWN_FAILED'
  | 'SERVICE_STARTUP_FAILED'
  | 'STATUS_UNAVAILABLE'
  | 'STOP_FAILED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_COMMAND'
  | 'HOST_ERROR'
  | 'HOST_RESPONSE_INVALID'
  | 'UNKNOWN';

export type NativeHostFailureError = {
  code: NativeHostErrorCode | string;
  message: string;
  action?: NativeHostAction;
  rawMessage?: string;
  hint?: string;
};

export type NativeHostState = {
  running: boolean;
  pid: number | null;
  baseUrl: string;
  token: string;
  startedAt: number | null;
  hostName: string;
};

export type NativeHostStatusPayload = {
  state: NativeHostState;
};

type NativeHostStatusRequest = {
  type: typeof NATIVE_HOST_STATUS;
};

type NativeHostStartRequest = {
  type: typeof NATIVE_HOST_START;
  token?: string;
};

type NativeHostStopRequest = {
  type: typeof NATIVE_HOST_STOP;
};

export type NativeHostBackgroundRequest = NativeHostStatusRequest | NativeHostStartRequest | NativeHostStopRequest;

type NativeHostSuccess<T> = {
  ok: true;
  data: T;
};

type NativeHostFailure = {
  ok: false;
  error: string | NativeHostFailureError;
};

export type NativeHostBackgroundResponse<T = NativeHostStatusPayload> = NativeHostSuccess<T> | NativeHostFailure;

export type NativeHostRequestError = Error & {
  code: NativeHostErrorCode | string;
  action: NativeHostAction;
  rawMessage?: string;
  hint?: string;
};

function toNativeHostAction(request: NativeHostBackgroundRequest): NativeHostAction {
  if (request.type === NATIVE_HOST_START) {
    return 'start';
  }

  if (request.type === NATIVE_HOST_STOP) {
    return 'stop';
  }

  return 'status';
}

function isNativeHostFailure(response: unknown): response is NativeHostFailure {
  return typeof response === 'object' && response !== null && 'ok' in response && (response as { ok: unknown }).ok === false;
}

function isNativeHostFailureError(value: unknown): value is NativeHostFailureError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

function normalizeNativeHostFailure(error: unknown, fallbackAction: NativeHostAction): NativeHostFailureError & { action: NativeHostAction } {
  if (isNativeHostFailureError(error)) {
    return {
      code: error.code,
      message: error.message,
      action: error.action ?? fallbackAction,
      rawMessage: typeof error.rawMessage === 'string' ? error.rawMessage : undefined,
      hint: typeof error.hint === 'string' ? error.hint : undefined,
    };
  }

  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const maybeAction = (error as { action?: unknown }).action;
    const maybeRaw = (error as { rawMessage?: unknown }).rawMessage;
    const maybeHint = (error as { hint?: unknown }).hint;

    return {
      code: typeof maybeCode === 'string' ? maybeCode : 'UNKNOWN',
      message: error.message || '本地宿主调用失败',
      action: maybeAction === 'start' || maybeAction === 'status' || maybeAction === 'stop' ? maybeAction : fallbackAction,
      rawMessage: typeof maybeRaw === 'string' ? maybeRaw : undefined,
      hint: typeof maybeHint === 'string' ? maybeHint : undefined,
    };
  }

  if (typeof error === 'string') {
    return {
      code: 'UNKNOWN',
      message: error,
      action: fallbackAction,
    };
  }

  return {
    code: 'UNKNOWN',
    message: '本地宿主调用失败',
    action: fallbackAction,
  };
}

function createNativeHostRequestError(payload: NativeHostFailureError & { action: NativeHostAction }): NativeHostRequestError {
  const error = new Error(payload.message) as NativeHostRequestError;
  error.code = payload.code;
  error.action = payload.action;
  if (payload.rawMessage) {
    error.rawMessage = payload.rawMessage;
  }
  if (payload.hint) {
    error.hint = payload.hint;
  }
  return error;
}

export function parseNativeHostError(error: unknown, fallbackAction: NativeHostAction): NativeHostFailureError & { action: NativeHostAction } {
  return normalizeNativeHostFailure(error, fallbackAction);
}

async function requestNativeHostBackground<T>(request: NativeHostBackgroundRequest): Promise<T> {
  const action = toNativeHostAction(request);
  const response = (await chrome.runtime.sendMessage(request)) as NativeHostBackgroundResponse<T> | undefined;

  if (!response) {
    throw createNativeHostRequestError({
      code: 'STATUS_UNAVAILABLE',
      message: '扩展后台未响应，请刷新页面后重试。',
      action,
    });
  }

  if (isNativeHostFailure(response)) {
    const normalized = normalizeNativeHostFailure(response.error, action);
    throw createNativeHostRequestError(normalized);
  }

  return response.data;
}

export async function requestNativeHostStatus(): Promise<NativeHostStatusPayload> {
  return requestNativeHostBackground<NativeHostStatusPayload>({ type: NATIVE_HOST_STATUS });
}

export async function requestNativeHostStart(token?: string): Promise<NativeHostStatusPayload> {
  return requestNativeHostBackground<NativeHostStatusPayload>({ type: NATIVE_HOST_START, token });
}

export async function requestNativeHostStop(): Promise<NativeHostStatusPayload> {
  return requestNativeHostBackground<NativeHostStatusPayload>({ type: NATIVE_HOST_STOP });
}

export function createNativeHostFailure(error: unknown, action: NativeHostAction = 'status'): NativeHostBackgroundResponse {
  const normalized = normalizeNativeHostFailure(error, action);
  return { ok: false, error: normalized };
}

export type NativeHostControlRequest =
  | {
      command: 'status';
    }
  | {
      command: 'start';
      port: number;
      token?: string;
    }
  | {
      command: 'stop';
    };

export type NativeHostControlResponse =
  | {
      ok: true;
      data: NativeHostState;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
