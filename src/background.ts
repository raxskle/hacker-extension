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
  getNotionCache,
  getNotionConfig,
  getNotionSyncState,
  getPanelEnabled,
  setNotionCache,
  setNotionSyncState,
  setPanelEnabled,
} from './shared/storage';
import { DEFAULT_NOTION_SYNC_STATE } from './shared/types';

let notionSyncInFlight: Promise<NotionCachePayload> | null = null;

async function syncActionState(enabled: boolean) {
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1e8e3e' : '#8b1e1e' });
  await chrome.action.setTitle({ title: enabled ? '点击关闭浮窗' : '点击开启浮窗' });
}

async function syncActionStateFromStorage() {
  const enabled = await getPanelEnabled();
  await syncActionState(enabled);
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

chrome.runtime.onInstalled.addListener(() => {
  void syncActionStateFromStorage();
  void setNotionSyncState(DEFAULT_NOTION_SYNC_STATE);
});

chrome.runtime.onStartup.addListener(() => {
  void syncActionStateFromStorage();
});

chrome.action.onClicked.addListener(() => {
  void (async () => {
    const enabled = await getPanelEnabled();
    const nextEnabled = !enabled;
    await setPanelEnabled(nextEnabled);
    await syncActionState(nextEnabled);
  })();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const request = message as Partial<NotionBackgroundRequest>;
  const isSupported =
    request.type === GET_NOTION_CACHE ||
    request.type === SYNC_NOTION_DATABASE ||
    request.type === CREATE_NOTION_RECORD ||
    request.type === UPDATE_NOTION_RECORD;

  if (!isSupported) {
    return undefined;
  }

  void (async () => {
    try {
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
    } catch (error) {
      sendResponse(createNotionFailure(error));
    }
  })();

  return true;
});

void syncActionStateFromStorage();
