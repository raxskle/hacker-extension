import type {
  NotionCacheSnapshot,
  NotionConfig,
  NotionDateValue,
  NotionFieldOption,
  NotionFieldSchema,
  NotionRecord,
  NotionRecordField,
  NotionRecordValue,
  NotionSyncState,
} from './types';

const NOTION_VERSION = '2022-06-28';
const NOTION_PAGE_SIZE = 100;
const URL_FIELD_LABEL = 'url';
const WRITABLE_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'select',
  'multi_select',
  'date',
]);

export const GET_NOTION_CACHE = 'notion/get-cache';
export const SYNC_NOTION_DATABASE = 'notion/sync';
export const CREATE_NOTION_RECORD = 'notion/create-record';
export const UPDATE_NOTION_RECORD = 'notion/update-record';

export type NotionFormValues = Record<string, NotionRecordValue>;

type RichTextItem = {
  plain_text?: string;
};

type NotionUser = {
  name?: string | null;
};

type NotionSchemaOption = {
  id?: string;
  name?: string | null;
};

type NotionSchemaProperty = {
  type?: string;
  name?: string;
  select?: { options?: NotionSchemaOption[] };
  multi_select?: { options?: NotionSchemaOption[] };
  status?: { options?: NotionSchemaOption[] };
};

type NotionPropertyValue = {
  type?: string;
  title?: RichTextItem[];
  rich_text?: RichTextItem[];
  number?: number | null;
  select?: { name?: string | null } | null;
  multi_select?: Array<{ name?: string | null }>;
  status?: { name?: string | null } | null;
  date?: { start?: string | null; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  people?: NotionUser[];
  created_by?: NotionUser | null;
  last_edited_by?: NotionUser | null;
  relation?: Array<{ id?: string }>;
  files?: Array<{ name?: string | null }>;
  formula?: {
    type?: string;
    string?: string | null;
    number?: number | null;
    boolean?: boolean | null;
    date?: { start?: string | null; end?: string | null } | null;
  } | null;
  rollup?: {
    type?: string;
    number?: number | null;
    date?: { start?: string | null; end?: string | null } | null;
    array?: NotionPropertyValue[];
  } | null;
  created_time?: string;
  last_edited_time?: string;
};

type NotionPage = {
  id: string;
  properties?: Record<string, NotionPropertyValue>;
};

type NotionDatabaseResponse = {
  title?: RichTextItem[];
  properties?: Record<string, NotionSchemaProperty>;
};

type NotionQueryResponse = {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionCacheRequest = {
  type: typeof GET_NOTION_CACHE;
};

type NotionSyncRequest = {
  type: typeof SYNC_NOTION_DATABASE;
};

type NotionCreateRecordRequest = {
  type: typeof CREATE_NOTION_RECORD;
  values: NotionFormValues;
};

type NotionUpdateRecordRequest = {
  type: typeof UPDATE_NOTION_RECORD;
  recordId: string;
  values: NotionFormValues;
};

export type NotionCachePayload = {
  cache: NotionCacheSnapshot | null;
  syncState: NotionSyncState;
};

type NotionBackgroundSuccess = {
  ok: true;
  data: NotionCachePayload;
};

type NotionBackgroundFailure = {
  ok: false;
  error: string;
};

export type NotionBackgroundResponse = NotionBackgroundSuccess | NotionBackgroundFailure;
export type NotionBackgroundRequest =
  | NotionCacheRequest
  | NotionSyncRequest
  | NotionCreateRecordRequest
  | NotionUpdateRecordRequest;

function joinPlainText(items: RichTextItem[] | undefined): string {
  return Array.isArray(items)
    ? items
        .map((item) => (typeof item?.plain_text === 'string' ? item.plain_text : ''))
        .join('')
        .trim()
    : '';
}

function normalizeConfigValue(value: string): string {
  return value.trim();
}

function formatDate(date: { start?: string | null; end?: string | null } | null | undefined): string {
  if (!date?.start) {
    return '-';
  }

  return date.end ? `${date.start} ~ ${date.end}` : date.start;
}

function formatUserList(users: NotionUser[] | undefined): string {
  if (!Array.isArray(users) || users.length === 0) {
    return '-';
  }

  return users.map((user) => user?.name?.trim() || '未命名用户').join('，');
}

function formatFormula(property: NotionPropertyValue['formula']): string {
  if (!property) {
    return '-';
  }

  switch (property.type) {
    case 'string':
      return property.string?.trim() || '-';
    case 'number':
      return property.number == null ? '-' : String(property.number);
    case 'boolean':
      return property.boolean == null ? '-' : property.boolean ? '是' : '否';
    case 'date':
      return formatDate(property.date);
    default:
      return '-';
  }
}

function formatRollup(property: NotionPropertyValue['rollup']): string {
  if (!property) {
    return '-';
  }

  switch (property.type) {
    case 'number':
      return property.number == null ? '-' : String(property.number);
    case 'date':
      return formatDate(property.date);
    case 'array':
      return Array.isArray(property.array) && property.array.length > 0
        ? property.array.map((item) => getNotionCellText(item)).join('，')
        : '-';
    default:
      return '-';
  }
}

export function getNotionCellText(property: NotionPropertyValue | undefined): string {
  if (!property?.type) {
    return '-';
  }

  switch (property.type) {
    case 'title': {
      const text = joinPlainText(property.title);
      return text || '-';
    }
    case 'rich_text': {
      const text = joinPlainText(property.rich_text);
      return text || '-';
    }
    case 'number':
      return property.number == null ? '-' : String(property.number);
    case 'select':
      return property.select?.name?.trim() || '-';
    case 'multi_select':
      return property.multi_select?.map((item) => item.name?.trim()).filter(Boolean).join('，') || '-';
    case 'status':
      return property.status?.name?.trim() || '-';
    case 'date':
      return formatDate(property.date);
    case 'checkbox':
      return property.checkbox ? '是' : '否';
    case 'url':
      return property.url?.trim() || '-';
    case 'email':
      return property.email?.trim() || '-';
    case 'phone_number':
      return property.phone_number?.trim() || '-';
    case 'people':
      return formatUserList(property.people);
    case 'created_by':
    case 'last_edited_by':
      return property[property.type]?.name?.trim() || '-';
    case 'relation':
      return property.relation?.map((item) => item.id?.trim()).filter(Boolean).join('，') || '-';
    case 'files':
      return property.files?.map((item) => item.name?.trim()).filter(Boolean).join('，') || '-';
    case 'formula':
      return formatFormula(property.formula);
    case 'rollup':
      return formatRollup(property.rollup);
    case 'created_time':
      return property.created_time?.trim() || '-';
    case 'last_edited_time':
      return property.last_edited_time?.trim() || '-';
    default:
      return '-';
  }
}

export function getNotionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '读取 Notion 数据失败';
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function handleNotionError(response: Response): Promise<never> {
  const payload = (await parseJson(response)) as { message?: string } | null;
  const message = payload?.message?.trim();

  if (response.status === 401 || response.status === 403) {
    throw new Error('Notion API Key 无效，或当前集成没有访问这个数据库的权限。');
  }

  if (response.status === 404) {
    throw new Error('找不到这个 Notion 数据库，或当前集成没有访问权限。');
  }

  if (response.status === 429) {
    throw new Error('Notion 请求过于频繁，请稍后再试。');
  }

  throw new Error(message || '读取 Notion 数据失败');
}

function normalizeOptionName(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function toSchemaOptions(options: NotionSchemaOption[] | undefined): NotionFieldOption[] | undefined {
  if (!Array.isArray(options) || options.length === 0) {
    return undefined;
  }

  const normalized = options.reduce<NotionFieldOption[]>((result, option) => {
    const name = normalizeOptionName(option.name);
    if (name) {
      result.push({ id: option.id, name });
    }
    return result;
  }, []);

  return normalized.length > 0 ? normalized : undefined;
}

function isWritableType(type: string): boolean {
  return WRITABLE_TYPES.has(type);
}

function normalizeFieldLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

export function extractHostname(value: string): string | null {
  const next = value.trim();
  if (!next) {
    return null;
  }

  try {
    return normalizeHostname(new URL(next).hostname);
  } catch {
    try {
      return normalizeHostname(new URL(`https://${next}`).hostname);
    } catch {
      return null;
    }
  }
}

function getFieldValue(property: NotionPropertyValue | undefined): NotionRecordValue {
  if (!property?.type) {
    return null;
  }

  switch (property.type) {
    case 'title':
      return joinPlainText(property.title) || '';
    case 'rich_text':
      return joinPlainText(property.rich_text) || '';
    case 'number':
      return property.number == null ? null : property.number;
    case 'select':
      return property.select?.name?.trim() || '';
    case 'multi_select':
      return (
        property.multi_select
          ?.map((item) => item.name?.trim())
          .filter((item): item is string => Boolean(item)) || []
      );
    case 'status':
      return property.status?.name?.trim() || '';
    case 'date':
      return property.date?.start
        ? {
            start: property.date.start,
            end: property.date.end?.trim() || '',
          }
        : null;
    case 'checkbox':
      return Boolean(property.checkbox);
    case 'url':
      return property.url?.trim() || '';
    case 'email':
      return property.email?.trim() || '';
    case 'phone_number':
      return property.phone_number?.trim() || '';
    default:
      return null;
  }
}

function getFieldSchema(database: NotionDatabaseResponse): NotionFieldSchema[] {
  const fields = Object.entries(database.properties ?? {}).map(([key, property]) => {
    const label = property.name?.trim() || key;
    const type = property.type?.trim() || 'unknown';
    const options =
      type === 'select'
        ? toSchemaOptions(property.select?.options)
        : type === 'multi_select'
          ? toSchemaOptions(property.multi_select?.options)
          : type === 'status'
            ? toSchemaOptions(property.status?.options)
            : undefined;

    return {
      key,
      label,
      type,
      isTitle: type === 'title',
      writable: isWritableType(type),
      options,
    };
  });

  return fields.sort((left, right) => Number(right.isTitle) - Number(left.isTitle));
}

function getUrlFieldKey(fields: NotionFieldSchema[]): string | null {
  const field = fields.find((item) => normalizeFieldLabel(item.label) === URL_FIELD_LABEL);
  return field?.key ?? null;
}

function toRecordField(schema: NotionFieldSchema, property: NotionPropertyValue | undefined): NotionRecordField {
  return {
    type: schema.type,
    value: getFieldValue(property),
    display: getNotionCellText(property),
    writable: schema.writable,
  };
}

function toRecord(page: NotionPage, fields: NotionFieldSchema[], urlFieldKey: string | null): NotionRecord {
  const recordFields = Object.fromEntries(
    fields.map((field) => [field.key, toRecordField(field, page.properties?.[field.key])]),
  ) as Record<string, NotionRecordField>;

  const hostname = urlFieldKey ? extractHostname(String(recordFields[urlFieldKey]?.value ?? '')) : null;
  return {
    id: page.id,
    hostname,
    fields: recordFields,
  };
}

function createSnapshot(
  databaseId: string,
  database: NotionDatabaseResponse,
  pages: NotionPage[],
  updatedAt: number,
): NotionCacheSnapshot {
  const fields = getFieldSchema(database);
  const urlFieldKey = getUrlFieldKey(fields);
  const records = pages.map((page) => toRecord(page, fields, urlFieldKey));

  return {
    databaseId: normalizeConfigValue(databaseId),
    title: joinPlainText(database.title) || 'Notion 数据库',
    urlFieldKey,
    rowCount: records.length,
    updatedAt,
    fields,
    records,
  };
}

export function isNotionConfigComplete(config: NotionConfig): boolean {
  return Boolean(normalizeConfigValue(config.apiKey) && normalizeConfigValue(config.databaseId));
}

function getNotionRequestMeta(config: NotionConfig) {
  const normalizedConfig = {
    apiKey: normalizeConfigValue(config.apiKey),
    databaseId: normalizeConfigValue(config.databaseId),
  };

  if (!isNotionConfigComplete(normalizedConfig)) {
    throw new Error('请先在设置中填写 Notion API Key 和 Database ID。');
  }

  const headers = {
    Authorization: `Bearer ${normalizedConfig.apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  const databaseUrl = `https://api.notion.com/v1/databases/${encodeURIComponent(normalizedConfig.databaseId)}`;
  const queryUrl = `${databaseUrl}/query`;

  return {
    databaseId: normalizedConfig.databaseId,
    headers,
    databaseUrl,
    queryUrl,
  };
}

async function fetchNotionQueryPage(
  queryUrl: string,
  headers: Record<string, string>,
  startCursor?: string,
): Promise<NotionQueryResponse> {
  const queryResponse = await fetch(queryUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      startCursor
        ? { page_size: NOTION_PAGE_SIZE, start_cursor: startCursor }
        : { page_size: NOTION_PAGE_SIZE },
    ),
  });

  if (!queryResponse.ok) {
    await handleNotionError(queryResponse);
  }

  return ((await parseJson(queryResponse)) as NotionQueryResponse | null) ?? {};
}

async function fetchAllNotionPages(queryUrl: string, headers: Record<string, string>): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let nextCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const query = await fetchNotionQueryPage(queryUrl, headers, nextCursor);
    if (Array.isArray(query.results) && query.results.length > 0) {
      pages.push(...query.results);
    }
    hasMore = Boolean(query.has_more);
    nextCursor = query.next_cursor?.trim() || undefined;
  }

  return pages;
}

export async function fetchNotionDatabase(
  config: NotionConfig,
  updatedAt = Date.now(),
): Promise<NotionCacheSnapshot> {
  const { databaseId, headers, databaseUrl, queryUrl } = getNotionRequestMeta(config);

  const [databaseResponse, pages] = await Promise.all([
    fetch(databaseUrl, { headers }),
    fetchAllNotionPages(queryUrl, headers),
  ]);

  if (!databaseResponse.ok) {
    await handleNotionError(databaseResponse);
  }

  const database = (await parseJson(databaseResponse)) as NotionDatabaseResponse | null;
  return createSnapshot(databaseId, database ?? {}, pages, updatedAt);
}

function createRichTextArray(value: string): Array<{ type: 'text'; text: { content: string } }> {
  const content = value.trim();
  return content ? [{ type: 'text', text: { content } }] : [];
}

function buildNotionDateValue(value: NotionRecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const start = (value as NotionDateValue).start?.trim();
  if (!start) {
    return null;
  }

  const end = (value as NotionDateValue).end?.trim() || null;
  return end ? { start, end } : { start };
}

function buildPropertyPayload(field: NotionFieldSchema, value: NotionRecordValue): Record<string, unknown> | null {
  switch (field.type) {
    case 'title': {
      const content = typeof value === 'string' ? value : '';
      return { title: createRichTextArray(content) };
    }
    case 'rich_text': {
      const content = typeof value === 'string' ? value : '';
      return { rich_text: createRichTextArray(content) };
    }
    case 'number':
      return { number: typeof value === 'number' ? value : value === null || value === '' ? null : Number(value) };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: typeof value === 'string' ? value.trim() || null : null };
    case 'email':
      return { email: typeof value === 'string' ? value.trim() || null : null };
    case 'phone_number':
      return { phone_number: typeof value === 'string' ? value.trim() || null : null };
    case 'select': {
      const name = typeof value === 'string' ? value.trim() : '';
      return { select: name ? { name } : null };
    }
    case 'status': {
      const name = typeof value === 'string' ? value.trim() : '';
      return { status: name ? { name } : null };
    }
    case 'multi_select': {
      const names = Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : [];
      return { multi_select: names.map((name) => ({ name })) };
    }
    case 'date':
      return { date: buildNotionDateValue(value) };
    default:
      return null;
  }
}

function buildPropertiesPayload(fields: NotionFieldSchema[], values: NotionFormValues): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => field.writable)
      .map((field) => {
        if (!(field.key in values)) {
          return null;
        }
        const payload = buildPropertyPayload(field, values[field.key] ?? null);
        return payload ? [field.key, payload] : null;
      })
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry)),
  );
}

async function writeNotionPage(
  config: NotionConfig,
  method: 'POST' | 'PATCH',
  values: NotionFormValues,
  recordId?: string,
): Promise<void> {
  const { databaseId, headers } = getNotionRequestMeta(config);
  const cache = await fetchNotionDatabase(config);
  const properties = buildPropertiesPayload(cache.fields, values);

  const url =
    method === 'POST'
      ? 'https://api.notion.com/v1/pages'
      : `https://api.notion.com/v1/pages/${encodeURIComponent(recordId ?? '')}`;

  const body =
    method === 'POST'
      ? { parent: { database_id: databaseId }, properties }
      : { properties };

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await handleNotionError(response);
  }
}

export async function createNotionRecord(config: NotionConfig, values: NotionFormValues): Promise<void> {
  await writeNotionPage(config, 'POST', values);
}

export async function updateNotionRecord(
  config: NotionConfig,
  recordId: string,
  values: NotionFormValues,
): Promise<void> {
  if (!recordId.trim()) {
    throw new Error('缺少要更新的 Notion 记录 ID。');
  }

  await writeNotionPage(config, 'PATCH', values, recordId);
}

async function requestNotionBackground(request: NotionBackgroundRequest): Promise<NotionCachePayload> {
  const response = (await chrome.runtime.sendMessage(request)) as NotionBackgroundResponse | undefined;

  if (!response) {
    throw new Error('扩展后台未响应，请刷新页面后重试。');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}

export async function requestNotionCache(): Promise<NotionCachePayload> {
  return requestNotionBackground({ type: GET_NOTION_CACHE });
}

export async function requestNotionSync(): Promise<NotionCachePayload> {
  return requestNotionBackground({ type: SYNC_NOTION_DATABASE });
}

export async function requestCreateNotionRecord(values: NotionFormValues): Promise<NotionCachePayload> {
  return requestNotionBackground({ type: CREATE_NOTION_RECORD, values });
}

export async function requestUpdateNotionRecord(
  recordId: string,
  values: NotionFormValues,
): Promise<NotionCachePayload> {
  return requestNotionBackground({ type: UPDATE_NOTION_RECORD, recordId, values });
}

export function createNotionFailure(error: unknown): NotionBackgroundResponse {
  return {
    ok: false,
    error: getNotionErrorMessage(error),
  };
}
