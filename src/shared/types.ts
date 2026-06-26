export type PanelPosition = {
  left: number;
  top: number;
};

export type PresetItem = {
  key: string;
  value: string;
};

export type PresetGroup = {
  id: string;
  label: string;
  domainKey: string;
  items: PresetItem[];
};

export type PresetGroupStore = {
  groups: PresetGroup[];
  activeGroupId: string | null;
};

export type NotionConfig = {
  apiKey: string;
  databaseId: string;
};

export type NotionFieldOption = {
  id?: string;
  name: string;
};

export type NotionDateValue = {
  start: string;
  end: string;
};

export type NotionRecordValue = string | number | boolean | string[] | NotionDateValue | null;

export type NotionFieldSchema = {
  key: string;
  label: string;
  type: string;
  isTitle: boolean;
  writable: boolean;
  options?: NotionFieldOption[];
};

export type NotionRecordField = {
  type: string;
  value: NotionRecordValue;
  display: string;
  writable: boolean;
};

export type NotionRecord = {
  id: string;
  hostname: string | null;
  fields: Record<string, NotionRecordField>;
};

export type NotionCacheSnapshot = {
  databaseId: string;
  title: string;
  urlFieldKey: string | null;
  rowCount: number;
  updatedAt: number;
  fields: NotionFieldSchema[];
  records: NotionRecord[];
};

export type NotionSyncState = {
  isSyncing: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
};

export type CaptureSourceType = 'fetch' | 'xhr' | 'beacon';

export type CaptureRecord = {
  id: string;
  source: CaptureSourceType;
  timestamp: number;
  url: string;
  method: string;
  status: number;
  contentType: string;
  requestBody: string;
  responseBody: string;
  responseEncoding: 'text' | 'unavailable';
  responseTruncated: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  error: string;
};

export type CaptureRecordSummary = {
  id: string;
  source: CaptureSourceType;
  timestamp: number;
  url: string;
  method: string;
  status: number;
  contentType: string;
  responseLength: number;
  responseTruncated: boolean;
  error: string;
};

export type CaptureRuntimeState = {
  isRecording: boolean;
  rule: string;
  tabId: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  capturedCount: number;
  droppedCount: number;
  totalChars: number;
  lastError: string;
  lastExportAt: number | null;
  recent: CaptureRecordSummary[];
};

export const DEFAULT_CAPTURE_RUNTIME_STATE: CaptureRuntimeState = {
  isRecording: false,
  rule: '',
  tabId: null,
  startedAt: null,
  stoppedAt: null,
  capturedCount: 0,
  droppedCount: 0,
  totalChars: 0,
  lastError: '',
  lastExportAt: null,
  recent: [],
};

export const DEFAULT_NOTION_SYNC_STATE: NotionSyncState = {
  isSyncing: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: '',
};

export const DEFAULT_PRESET_GROUP_STORE: PresetGroupStore = {
  groups: [],
  activeGroupId: null,
};

export const STORAGE_KEYS = {
  presetTexts: 'presetTexts',
  presetGroups: 'presetGroups',
  panelPosition: 'panelPosition',
  panelEnabled: 'panelEnabled',
  panelHiddenDomains: 'panelHiddenDomains',
  notionApiKey: 'notionApiKey',
  notionDatabaseId: 'notionDatabaseId',
  notionCache: 'notionCache',
  notionSyncState: 'notionSyncState',
  notionDetailCollapsed: 'notionDetailCollapsed',
  presetDetailCollapsed: 'presetDetailCollapsed',
  captureRule: 'captureRule',
  captureRuntimeState: 'captureRuntimeState',
  captureRecords: 'captureRecords',
} as const;

export const DEFAULT_PRESET_ITEMS: PresetItem[] = [
  { key: '已收到', value: '你好，已收到。' },
  { key: '处理中', value: '请稍等，我马上处理。' },
  { key: '感谢反馈', value: '感谢反馈，我们会尽快回复。' },
];
