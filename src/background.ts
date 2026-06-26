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
  CAPTURE_ENSURE_HOOK,
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
  setCaptureRecords,
  setCaptureRule,
  setCaptureRuntimeState,
  setNotionCache,
  setNotionSyncState,
  setPanelEnabled,
} from './shared/storage';
import {
  DEFAULT_CAPTURE_RUNTIME_STATE,
  DEFAULT_NOTION_SYNC_STATE,
  type CaptureRecord,
  type CaptureRecordSummary,
  type CaptureRuntimeState,
} from './shared/types';

let notionSyncInFlight: Promise<NotionCachePayload> | null = null;
let captureState: CaptureRuntimeState = DEFAULT_CAPTURE_RUNTIME_STATE;
let captureRecords: CaptureRecord[] = [];

const MAX_CAPTURE_RECORDS = 400;
const MAX_CAPTURE_TOTAL_CHARS = 4_000_000;

async function syncActionState(enabled: boolean) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1e8e3e' : '#8b1e1e' });
  await chrome.action.setTitle({ title: enabled ? '点击关闭浮窗' : '点击开启浮窗' });
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
  compileCaptureMatcher(normalizedRule);

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

  if (typeof tabId === 'number') {
    void chrome.tabs.sendMessage(tabId, { type: CAPTURE_ENSURE_HOOK }).catch(() => {
      // Ignore ensure-hook failures, capture pipeline can still work on injected pages.
    });
  }

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
    return captureState;
  }

  let matched = false;
  try {
    matched = isCaptureUrlMatched(payload.url, captureState.rule);
  } catch (error) {
    captureState = {
      ...captureState,
      lastError: error instanceof Error ? error.message : '录制规则无效',
    };
    await setCaptureRuntimeState(captureState);
    return captureState;
  }

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
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

async function exportCapture(): Promise<CaptureExportPayload> {
  if (captureRecords.length === 0) {
    throw new Error('当前没有可下载的录制数据');
  }

  const now = Date.now();
  const endpointSummary = buildEndpointSummary(captureRecords);
  const body = {
    meta: {
      exportedAt: now,
      rule: captureState.rule,
      startedAt: captureState.startedAt,
      stoppedAt: captureState.stoppedAt,
      capturedCount: captureState.capturedCount,
      droppedCount: captureState.droppedCount,
      totalChars: captureState.totalChars,
    },
    records: captureRecords,
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
  const blob = new Blob([serialized], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);

  const fileName = `hacker-capture-${toSafeFileStamp(now)}.json`;
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: fileName,
      saveAs: false,
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
      count: captureRecords.length,
    };
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncActionStateFromStorage();
  void setNotionSyncState(DEFAULT_NOTION_SYNC_STATE);
  void setCaptureRuntimeState(DEFAULT_CAPTURE_RUNTIME_STATE);
  void clearCaptureRecords();
  void setCaptureRule('');
});

chrome.runtime.onStartup.addListener(() => {
  void syncActionStateFromStorage();
  void syncCaptureStateFromStorage();
});

chrome.action.onClicked.addListener(() => {
  void (async () => {
    const enabled = await getPanelEnabled();
    const nextEnabled = !enabled;
    await setPanelEnabled(nextEnabled);
    await syncActionState(nextEnabled);
  })();
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

  if (!isNotionRequest && !isCaptureRequest) {
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
      } else {
        sendResponse(createCaptureFailure(error));
      }
    }
  })();

  return true;
});

void syncActionStateFromStorage();
void syncCaptureStateFromStorage();
