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
} as const;

export const DEFAULT_PRESET_ITEMS: PresetItem[] = [
  { key: '已收到', value: '你好，已收到。' },
  { key: '处理中', value: '请稍等，我马上处理。' },
  { key: '感谢反馈', value: '感谢反馈，我们会尽快回复。' },
];
