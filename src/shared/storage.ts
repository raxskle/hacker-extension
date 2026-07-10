import {
  DEFAULT_CAPTURE_RUNTIME_STATE,
  DEFAULT_NOTION_SYNC_STATE,
  DEFAULT_PRESET_GROUP_STORE,
  DEFAULT_PRESET_ITEMS,
  DEFAULT_SIM_PROXY_BRIDGE_CONFIG,
  STORAGE_KEYS,
  type CaptureRecord,
  type CaptureRecordSummary,
  type CaptureRuntimeState,
  type NotionCacheSnapshot,
  type NotionConfig,
  type NotionDateValue,
  type NotionRecordField,
  type NotionRecordValue,
  type NotionSyncState,
  type PanelPosition,
  type PresetGroup,
  type PresetGroupStore,
  type PresetItem,
  type SimProxyBridgeConfig,
  type SimProxyInFlightRecord,
  type SimProxyInFlightStore,
} from './types';
import { extractHostname } from './notion';

function normalizePresetItems(input: unknown): PresetItem[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((item): PresetItem | null => {
      if (typeof item === 'string') {
        const value = item.trim();
        if (!value) return null;
        const key = value.length > 16 ? `${value.slice(0, 16)}…` : value;
        return { key, value };
      }

      if (typeof item === 'object' && item !== null) {
        const raw = item as { key?: unknown; value?: unknown; label?: unknown; text?: unknown };
        const key =
          typeof raw.key === 'string'
            ? raw.key.trim()
            : typeof raw.label === 'string'
              ? raw.label.trim()
              : '';
        const value =
          typeof raw.value === 'string'
            ? raw.value.trim()
            : typeof raw.text === 'string'
              ? raw.text.trim()
              : '';

        if (!key || !value) return null;
        return { key, value };
      }

      return null;
    })
    .filter((item): item is PresetItem => Boolean(item));

  return normalized;
}

function createPresetGroup(domainKey: string, items: PresetItem[]): PresetGroup {
  const nextDomainKey = domainKey.trim();
  return {
    id: nextDomainKey || `group-${Date.now()}`,
    label: nextDomainKey || '默认分组',
    domainKey: nextDomainKey,
    items,
  };
}

function normalizePresetGroup(input: unknown): PresetGroup | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const raw = input as {
    id?: unknown;
    label?: unknown;
    domainKey?: unknown;
    items?: unknown;
  };
  const items = normalizePresetItems(raw.items);
  const domainKey = typeof raw.domainKey === 'string' ? raw.domainKey.trim() : '';
  const label = typeof raw.label === 'string' ? raw.label.trim() : domainKey;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : domainKey;

  if (!id) {
    return null;
  }

  return {
    id,
    label: label || id,
    domainKey,
    items,
  };
}

function normalizePresetGroupStore(input: unknown): PresetGroupStore {
  if (typeof input !== 'object' || input === null) {
    return DEFAULT_PRESET_GROUP_STORE;
  }

  const raw = input as { groups?: unknown; activeGroupId?: unknown };
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((group) => normalizePresetGroup(group)).filter((group): group is PresetGroup => Boolean(group))
    : [];
  const activeGroupId = typeof raw.activeGroupId === 'string' ? raw.activeGroupId.trim() : '';
  const nextActiveGroupId = groups.some((group) => group.id === activeGroupId)
    ? activeGroupId
    : groups[0]?.id ?? null;

  return {
    groups,
    activeGroupId: nextActiveGroupId,
  };
}

async function migrateLegacyPresetTexts(): Promise<PresetGroupStore | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.presetTexts);
  const legacyItems = normalizePresetItems(data[STORAGE_KEYS.presetTexts]);
  if (legacyItems.length === 0) {
    return null;
  }

  const store: PresetGroupStore = {
    groups: [createPresetGroup('default', legacyItems)],
    activeGroupId: 'default',
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.presetGroups]: store });
  return store;
}

export async function getPresetGroupStore(): Promise<PresetGroupStore> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.presetGroups);
  const existing = normalizePresetGroupStore(data[STORAGE_KEYS.presetGroups]);
  if (existing.groups.length > 0) {
    return existing;
  }

  const migrated = await migrateLegacyPresetTexts();
  if (migrated) {
    return migrated;
  }

  const fallback: PresetGroupStore = {
    groups: [createPresetGroup('default', DEFAULT_PRESET_ITEMS)],
    activeGroupId: 'default',
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.presetGroups]: fallback });
  return fallback;
}

export async function setPresetGroupStore(store: PresetGroupStore): Promise<void> {
  const normalized = normalizePresetGroupStore(store);
  const nextStore =
    normalized.groups.length > 0
      ? normalized
      : {
          groups: [createPresetGroup('default', DEFAULT_PRESET_ITEMS)],
          activeGroupId: 'default',
        };

  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.presetGroups]: nextStore,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota/i.test(message) || /exceed/i.test(message)) {
      throw new Error('本地存储空间不足，已无法保存分组配置。请刷新 Notion 缓存数据范围或清理数据后重试。');
    }
    throw error;
  }
}

export async function getPresetTexts(): Promise<PresetItem[]> {
  const store = await getPresetGroupStore();
  const activeGroup = store.groups.find((group) => group.id === store.activeGroupId) ?? store.groups[0];
  return activeGroup?.items ?? DEFAULT_PRESET_ITEMS;
}

export async function setPresetTexts(presetItems: PresetItem[]): Promise<void> {
  const next = normalizePresetItems(presetItems);
  const store = await getPresetGroupStore();
  const activeGroupId = store.activeGroupId ?? store.groups[0]?.id ?? 'default';
  const groups = store.groups.map((group) =>
    group.id === activeGroupId
      ? { ...group, items: next.length > 0 ? next : DEFAULT_PRESET_ITEMS }
      : group,
  );

  await setPresetGroupStore({ groups, activeGroupId });
}

function normalizeStoredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function getNotionConfig(): Promise<NotionConfig> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.notionApiKey,
    STORAGE_KEYS.notionDatabaseId,
  ]);

  return {
    apiKey: normalizeStoredString(data[STORAGE_KEYS.notionApiKey]),
    databaseId: normalizeStoredString(data[STORAGE_KEYS.notionDatabaseId]),
  };
}

export async function setNotionConfig(config: NotionConfig): Promise<void> {
  const nextApiKey = config.apiKey.trim();
  const nextDatabaseId = config.databaseId.trim();
  const current = await getNotionConfig();
  const hasChanged = current.apiKey !== nextApiKey || current.databaseId !== nextDatabaseId;

  await chrome.storage.local.set({
    [STORAGE_KEYS.notionApiKey]: nextApiKey,
    [STORAGE_KEYS.notionDatabaseId]: nextDatabaseId,
  });

  if (hasChanged) {
    await clearNotionCache();
  }
}

function isNotionDateValue(value: unknown): value is NotionDateValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NotionDateValue).start === 'string' &&
    typeof (value as NotionDateValue).end === 'string'
  );
}

function isNotionRecordValue(value: unknown): value is NotionRecordValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string')) ||
    isNotionDateValue(value)
  );
}

function isNotionRecordField(value: unknown): value is NotionRecordField {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NotionRecordField).type === 'string' &&
    typeof (value as NotionRecordField).display === 'string' &&
    typeof (value as NotionRecordField).writable === 'boolean' &&
    isNotionRecordValue((value as NotionRecordField).value)
  );
}

function isNotionCacheSnapshot(value: unknown): value is NotionCacheSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const snapshot = value as Partial<NotionCacheSnapshot>;
  return (
    typeof snapshot.databaseId === 'string' &&
    typeof snapshot.title === 'string' &&
    (typeof snapshot.urlFieldKey === 'string' || snapshot.urlFieldKey === null) &&
    typeof snapshot.rowCount === 'number' &&
    typeof snapshot.updatedAt === 'number' &&
    Array.isArray(snapshot.fields) &&
    snapshot.fields.every(
      (field) =>
        typeof field === 'object' &&
        field !== null &&
        typeof field.key === 'string' &&
        typeof field.label === 'string' &&
        typeof field.type === 'string' &&
        typeof field.isTitle === 'boolean' &&
        typeof field.writable === 'boolean' &&
        (field.options == null ||
          (Array.isArray(field.options) &&
            field.options.every(
              (option) =>
                typeof option === 'object' && option !== null && typeof option.name === 'string',
            )))
    ) &&
    Array.isArray(snapshot.records) &&
    snapshot.records.every(
      (record) =>
        typeof record === 'object' &&
        record !== null &&
        typeof record.id === 'string' &&
        (typeof record.hostname === 'string' || record.hostname === null) &&
        typeof record.fields === 'object' &&
        record.fields !== null &&
        Object.values(record.fields).every((field) => isNotionRecordField(field)),
    )
  );
}

function isNotionSyncState(value: unknown): value is NotionSyncState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const state = value as Partial<NotionSyncState>;
  return (
    typeof state.isSyncing === 'boolean' &&
    (typeof state.lastAttemptAt === 'number' || state.lastAttemptAt === null) &&
    (typeof state.lastSuccessAt === 'number' || state.lastSuccessAt === null) &&
    typeof state.lastError === 'string'
  );
}

export async function getNotionCache(): Promise<NotionCacheSnapshot | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.notionCache);
  const value = data[STORAGE_KEYS.notionCache];
  return isNotionCacheSnapshot(value) ? value : null;
}

export async function setNotionCache(snapshot: NotionCacheSnapshot): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.notionCache]: snapshot });
}

export async function clearNotionCache(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.notionCache);
  await setNotionSyncState(DEFAULT_NOTION_SYNC_STATE);
}

export async function getNotionSyncState(): Promise<NotionSyncState> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.notionSyncState);
  const value = data[STORAGE_KEYS.notionSyncState];
  return isNotionSyncState(value) ? value : DEFAULT_NOTION_SYNC_STATE;
}

export async function setNotionSyncState(state: NotionSyncState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.notionSyncState]: state });
}

export async function getNotionDetailCollapsed(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.notionDetailCollapsed);
  const value = data[STORAGE_KEYS.notionDetailCollapsed];

  if (typeof value === 'boolean') {
    return value;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.notionDetailCollapsed]: true });
  return true;
}

export async function setNotionDetailCollapsed(collapsed: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.notionDetailCollapsed]: collapsed });
}

export async function getPresetDetailCollapsed(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.presetDetailCollapsed);
  const value = data[STORAGE_KEYS.presetDetailCollapsed];

  if (typeof value === 'boolean') {
    return value;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.presetDetailCollapsed]: false });
  return false;
}

export async function setPresetDetailCollapsed(collapsed: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.presetDetailCollapsed]: collapsed });
}

function isCaptureSourceType(value: unknown): value is CaptureRecordSummary['source'] {
  return value === 'fetch' || value === 'xhr' || value === 'beacon';
}

function normalizeCaptureRecordSummary(value: unknown): CaptureRecordSummary | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Partial<CaptureRecordSummary>;
  if (
    typeof record.id !== 'string' ||
    !isCaptureSourceType(record.source) ||
    typeof record.timestamp !== 'number' ||
    typeof record.url !== 'string' ||
    typeof record.method !== 'string' ||
    typeof record.status !== 'number' ||
    typeof record.contentType !== 'string' ||
    typeof record.responseLength !== 'number' ||
    typeof record.responseTruncated !== 'boolean' ||
    typeof record.error !== 'string'
  ) {
    return null;
  }

  return {
    id: record.id,
    source: record.source,
    timestamp: record.timestamp,
    url: record.url,
    method: record.method,
    status: record.status,
    contentType: record.contentType,
    responseLength: record.responseLength,
    responseTruncated: record.responseTruncated,
    error: record.error,
  };
}

function normalizeCaptureRuntimeState(input: unknown): CaptureRuntimeState {
  if (typeof input !== 'object' || input === null) {
    return DEFAULT_CAPTURE_RUNTIME_STATE;
  }

  const raw = input as Partial<CaptureRuntimeState>;
  const recent = Array.isArray(raw.recent)
    ? raw.recent
        .map((item) => normalizeCaptureRecordSummary(item))
        .filter((item): item is CaptureRecordSummary => Boolean(item))
        .slice(0, 20)
    : [];

  return {
    isRecording: typeof raw.isRecording === 'boolean' ? raw.isRecording : false,
    rule: typeof raw.rule === 'string' ? raw.rule : '',
    tabId: typeof raw.tabId === 'number' ? raw.tabId : null,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null,
    stoppedAt: typeof raw.stoppedAt === 'number' ? raw.stoppedAt : null,
    capturedCount: typeof raw.capturedCount === 'number' ? raw.capturedCount : 0,
    droppedCount: typeof raw.droppedCount === 'number' ? raw.droppedCount : 0,
    totalChars: typeof raw.totalChars === 'number' ? raw.totalChars : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
    lastExportAt: typeof raw.lastExportAt === 'number' ? raw.lastExportAt : null,
    recent,
  };
}

export async function getCaptureRule(): Promise<string> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.captureRule);
  const value = data[STORAGE_KEYS.captureRule];
  return typeof value === 'string' ? value.trim() : '';
}

export async function setCaptureRule(rule: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.captureRule]: rule.trim() });
}

export async function getCaptureRuntimeState(): Promise<CaptureRuntimeState> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.captureRuntimeState);
  const value = data[STORAGE_KEYS.captureRuntimeState];
  return normalizeCaptureRuntimeState(value);
}

export async function setCaptureRuntimeState(state: CaptureRuntimeState): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.captureRuntimeState]: normalizeCaptureRuntimeState(state),
  });
}

export async function clearCaptureRuntimeState(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.captureRuntimeState]: DEFAULT_CAPTURE_RUNTIME_STATE });
}

function normalizeHeaderRecord(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null) {
    return {};
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => [key, typeof value === 'string' ? value : String(value)] as const)
    .filter(([key]) => key.trim().length > 0);

  return Object.fromEntries(entries);
}

function normalizeCaptureRecord(value: unknown): CaptureRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Partial<CaptureRecord>;
  if (
    typeof record.id !== 'string' ||
    !isCaptureSourceType(record.source) ||
    typeof record.timestamp !== 'number' ||
    typeof record.url !== 'string' ||
    typeof record.method !== 'string' ||
    typeof record.status !== 'number' ||
    typeof record.contentType !== 'string' ||
    typeof record.requestBody !== 'string' ||
    typeof record.responseBody !== 'string' ||
    (record.responseEncoding !== 'text' && record.responseEncoding !== 'unavailable') ||
    typeof record.responseTruncated !== 'boolean' ||
    typeof record.error !== 'string'
  ) {
    return null;
  }

  return {
    id: record.id,
    source: record.source,
    timestamp: record.timestamp,
    url: record.url,
    method: record.method,
    status: record.status,
    contentType: record.contentType,
    requestBody: record.requestBody,
    responseBody: record.responseBody,
    responseEncoding: record.responseEncoding,
    responseTruncated: record.responseTruncated,
    requestHeaders: normalizeHeaderRecord(record.requestHeaders),
    responseHeaders: normalizeHeaderRecord(record.responseHeaders),
    error: record.error,
  };
}

function normalizeCaptureRecords(input: unknown): CaptureRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => normalizeCaptureRecord(item))
    .filter((item): item is CaptureRecord => Boolean(item));
}

export async function getCaptureRecords(): Promise<CaptureRecord[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.captureRecords);
  return normalizeCaptureRecords(data[STORAGE_KEYS.captureRecords]);
}

export async function setCaptureRecords(records: CaptureRecord[]): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.captureRecords]: normalizeCaptureRecords(records),
  });
}

export async function clearCaptureRecords(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.captureRecords]: [] });
}

function normalizeDomainRule(value: string): string | null {
  const normalized = extractHostname(value);
  if (normalized) {
    return normalized;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizePanelHiddenDomains(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') {
      continue;
    }

    const normalized = normalizeDomainRule(item);
    if (!normalized) {
      continue;
    }

    deduped.add(normalized);
  }

  return [...deduped];
}

export async function getPanelHiddenDomains(): Promise<string[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.panelHiddenDomains);
  const normalized = normalizePanelHiddenDomains(data[STORAGE_KEYS.panelHiddenDomains]);

  if (Array.isArray(data[STORAGE_KEYS.panelHiddenDomains])) {
    return normalized;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.panelHiddenDomains]: normalized });
  return normalized;
}

export async function setPanelHiddenDomains(domains: string[]): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.panelHiddenDomains]: normalizePanelHiddenDomains(domains),
  });
}

export async function getPanelEnabled(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.panelEnabled);
  const value = data[STORAGE_KEYS.panelEnabled];

  if (typeof value === 'boolean') {
    return value;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.panelEnabled]: true });
  return true;
}

export async function setPanelEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.panelEnabled]: enabled });
}

function isPanelPosition(value: unknown): value is PanelPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PanelPosition).left === 'number' &&
    typeof (value as PanelPosition).top === 'number'
  );
}

export async function getPanelPosition(): Promise<PanelPosition | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.panelPosition);
  const value = data[STORAGE_KEYS.panelPosition];
  return isPanelPosition(value) ? value : null;
}

export async function setPanelPosition(position: PanelPosition): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.panelPosition]: position });
}

function normalizeSimProxyBridgeConfig(input: unknown): SimProxyBridgeConfig {
  if (typeof input !== 'object' || input === null) {
    return DEFAULT_SIM_PROXY_BRIDGE_CONFIG;
  }

  const raw = input as Partial<SimProxyBridgeConfig>;
  const baseUrlRaw = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  let baseUrl = DEFAULT_SIM_PROXY_BRIDGE_CONFIG.baseUrl;

  if (baseUrlRaw) {
    try {
      const parsed = new URL(baseUrlRaw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        baseUrl = parsed.origin;
      }
    } catch {
      // keep default
    }
  }

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SIM_PROXY_BRIDGE_CONFIG.enabled,
    baseUrl,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
  };
}

export async function getSimProxyBridgeConfig(): Promise<SimProxyBridgeConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.simProxyBridgeConfig);
  const value = normalizeSimProxyBridgeConfig(data[STORAGE_KEYS.simProxyBridgeConfig]);

  if (typeof data[STORAGE_KEYS.simProxyBridgeConfig] !== 'object' || data[STORAGE_KEYS.simProxyBridgeConfig] === null) {
    await chrome.storage.local.set({ [STORAGE_KEYS.simProxyBridgeConfig]: value });
  }

  return value;
}

export async function setSimProxyBridgeConfig(config: SimProxyBridgeConfig): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.simProxyBridgeConfig]: normalizeSimProxyBridgeConfig(config),
  });
}

function normalizeSimProxyInFlightStore(input: unknown, now = Date.now()): SimProxyInFlightStore {
  if (typeof input !== 'object' || input === null) {
    return {};
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .map(([id, value]) => {
      if (typeof value !== 'object' || value === null) {
        return null;
      }

      const raw = value as Partial<SimProxyInFlightRecord>;
      const timeoutMs =
        typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
          ? Math.max(1_000, Math.round(raw.timeoutMs))
          : 45_000;
      const createdAt =
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? Math.round(raw.createdAt) : now;
      const expiresAt =
        typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
          ? Math.round(raw.expiresAt)
          : now + timeoutMs + 20_000;
      const normalizedId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : id.trim();
      const origin = typeof raw.origin === 'string' ? raw.origin.trim() : '';

      if (!normalizedId || !origin || expiresAt <= now) {
        return null;
      }

      const normalized: SimProxyInFlightRecord = {
        id: normalizedId,
        origin,
        timeoutMs,
        createdAt,
        expiresAt,
      };

      return [normalizedId, normalized] as const;
    })
    .filter((entry): entry is readonly [string, SimProxyInFlightRecord] => Boolean(entry));

  return Object.fromEntries(entries);
}

export async function getSimProxyInFlightStore(): Promise<SimProxyInFlightStore> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.simProxyInFlight);
  const raw = data[STORAGE_KEYS.simProxyInFlight];
  const value = normalizeSimProxyInFlightStore(raw);

  const rawCount = typeof raw === 'object' && raw !== null ? Object.keys(raw as Record<string, unknown>).length : -1;
  if (rawCount !== Object.keys(value).length) {
    await chrome.storage.local.set({ [STORAGE_KEYS.simProxyInFlight]: value });
  }

  return value;
}

export async function getSimProxyInFlightRecord(requestId: string): Promise<SimProxyInFlightRecord | null> {
  const normalizedId = requestId.trim();
  if (!normalizedId) {
    return null;
  }

  const store = await getSimProxyInFlightStore();
  return store[normalizedId] ?? null;
}

export async function upsertSimProxyInFlightRecord(record: SimProxyInFlightRecord): Promise<void> {
  const store = await getSimProxyInFlightStore();
  await chrome.storage.local.set({
    [STORAGE_KEYS.simProxyInFlight]: {
      ...store,
      [record.id]: record,
    },
  });
}

export async function deleteSimProxyInFlightRecord(requestId: string): Promise<void> {
  const normalizedId = requestId.trim();
  if (!normalizedId) {
    return;
  }

  const store = await getSimProxyInFlightStore();
  if (!store[normalizedId]) {
    return;
  }

  const next = { ...store };
  delete next[normalizedId];
  await chrome.storage.local.set({ [STORAGE_KEYS.simProxyInFlight]: next });
}
