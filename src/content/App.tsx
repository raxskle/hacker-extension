import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  getNotionCache,
  getNotionConfig,
  getNotionSyncState,
  getPanelPosition,
  getPresetGroupStore,
  setNotionConfig,
  setPanelPosition,
  setPresetGroupStore,
} from '../shared/storage';
import {
  extractHostname,
  getNotionErrorMessage,
  isNotionConfigComplete,
  requestCreateNotionRecord,
  requestNotionCache,
  requestNotionSync,
  requestUpdateNotionRecord,
  type NotionFormValues,
} from '../shared/notion';
import {
  DEFAULT_NOTION_SYNC_STATE,
  DEFAULT_PRESET_GROUP_STORE,
  DEFAULT_PRESET_ITEMS,
  STORAGE_KEYS,
  type NotionCacheSnapshot,
  type NotionConfig,
  type NotionDateValue,
  type NotionFieldSchema,
  type NotionRecord,
  type NotionRecordValue,
  type NotionSyncState,
  type PanelPosition,
  type PresetGroup,
  type PresetGroupStore,
  type PresetItem,
} from '../shared/types';

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type NotionPanelMode = 'view' | 'edit' | 'create';
type EditMode = 'none' | 'tabs' | 'presets' | 'notion';

const BLOCKED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'file',
  'hidden',
  'image',
  'month',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'week',
]);
const QUICK_UPDATE_TYPES = new Set(['title', 'rich_text', 'url', 'email', 'phone_number', 'select']);

function isTextInput(element: Element): element is HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }

  return !BLOCKED_INPUT_TYPES.has(element.type);
}

function isContentEditableElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.isContentEditable;
}

function isEditableTarget(target: EventTarget | null): target is EditableTarget {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }

  if (isTextInput(target)) {
    return !target.readOnly && !target.disabled;
  }

  return isContentEditableElement(target);
}

function resolveEditableTarget(target: EventTarget | null): EditableTarget | null {
  if (!(target instanceof Node)) {
    return null;
  }

  const element = target instanceof Element ? target : target.parentElement;
  if (!element) {
    return null;
  }

  if (isEditableTarget(element)) {
    return element;
  }

  const nearest = element.closest('input, textarea, [contenteditable]');
  if (!nearest || !isEditableTarget(nearest)) {
    return null;
  }

  return nearest;
}

function clampPosition(position: PanelPosition, width: number, height: number): PanelPosition {
  const minLeft = 8;
  const minTop = 8;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - 8);
  const maxTop = Math.max(minTop, window.innerHeight - height - 8);

  return {
    left: Math.min(Math.max(position.left, minLeft), maxLeft),
    top: Math.min(Math.max(position.top, minTop), maxTop),
  };
}

function getDefaultPosition(): PanelPosition {
  return {
    left: Math.max(window.innerWidth - 480, 16),
    top: Math.max(window.innerHeight - 420, 16),
  };
}

function cloneItems(items: PresetItem[]): PresetItem[] {
  return items.map((item) => ({ ...item }));
}

function clonePresetGroupStore(store: PresetGroupStore): PresetGroupStore {
  return {
    groups: store.groups.map((group) => ({
      ...group,
      items: cloneItems(group.items),
    })),
    activeGroupId: store.activeGroupId,
  };
}

function normalizeDomainKeyInput(value: string): string {
  const normalized = extractHostname(value);
  return normalized ?? value.trim().toLowerCase().replace(/^www\./, '');
}

function parseUrlLike(value: string): URL | null {
  const next = value.trim();
  if (!next) {
    return null;
  }

  try {
    return new URL(next);
  } catch {
    try {
      return new URL(`https://${next}`);
    } catch {
      return null;
    }
  }
}

function getRoamUrlIdentity(value: string): string | null {
  const parsed = parseUrlLike(value);
  if (!parsed) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${hostname}${pathname}`;
}

function getRoamTargetUrl(value: string): string | null {
  const parsed = parseUrlLike(value);
  return parsed?.href ?? null;
}

function getSpamFieldKey(cache: NotionCacheSnapshot): string | null {
  const field = cache.fields.find((item) => {
    const byLabel = normalizeDomainKeyInput(item.label);
    const byKey = normalizeDomainKeyInput(item.key);
    return byLabel.includes('spam') || byKey.includes('spam');
  });

  return field?.key ?? null;
}

function isSpamValue(value: NotionRecordValue | undefined): boolean {
  if (value === true) {
    return true;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'yes' || normalized === '是';
  }

  if (Array.isArray(value)) {
    return value.some((item) => {
      const normalized = item.trim().toLowerCase();
      return normalized === 'yes' || normalized === '是';
    });
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  return false;
}

function createPresetGroup(domainKey: string, items: PresetItem[] = []): PresetGroup {
  const nextDomainKey = normalizeDomainKeyInput(domainKey);
  const label = nextDomainKey || 'default';
  return {
    id: label,
    label,
    domainKey: nextDomainKey,
    items,
  };
}

function createFallbackPresetGroupStore(): PresetGroupStore {
  return {
    groups: [createPresetGroup('default', DEFAULT_PRESET_ITEMS)],
    activeGroupId: 'default',
  };
}

function cloneNotionConfig(config: NotionConfig): NotionConfig {
  return { ...config };
}

function cloneNotionValue(value: NotionRecordValue): NotionRecordValue {
  if (Array.isArray(value)) {
    return [...value];
  }

  if (value && typeof value === 'object') {
    const date = value as NotionDateValue;
    return { start: date.start, end: date.end };
  }

  return value;
}

function createFormValues(
  cache: NotionCacheSnapshot,
  record: NotionRecord | null,
  currentPageUrl: string,
): NotionFormValues {
  return Object.fromEntries(
    cache.fields.map((field) => {
      const existingValue = record?.fields[field.key]?.value;
      if (existingValue !== undefined) {
        return [field.key, cloneNotionValue(existingValue)];
      }

      if (field.key === cache.urlFieldKey) {
        return [field.key, currentPageUrl];
      }

      switch (field.type) {
        case 'checkbox':
          return [field.key, false];
        case 'multi_select':
          return [field.key, []];
        case 'number':
        case 'date':
          return [field.key, null];
        default:
          return [field.key, ''];
      }
    }),
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return '未知错误';
  }
}

function formatSyncTime(timestamp: number | null): string {
  if (!timestamp) {
    return '未同步';
  }

  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return '刚刚同步';
  }

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟前同步`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} 小时前同步`;
}

function getNotionStatusText(
  configured: boolean,
  syncState: NotionSyncState,
  cache: NotionCacheSnapshot | null,
): string {
  if (!configured) {
    return '未配置';
  }

  if (syncState.isSyncing) {
    return cache ? '正在同步缓存' : '正在读取数据';
  }

  if (syncState.lastError) {
    return cache ? '缓存可用，最近同步失败' : '最近同步失败';
  }

  if (cache) {
    return formatSyncTime(syncState.lastSuccessAt ?? cache.updatedAt);
  }

  return '尚未同步';
}

function getFieldDisplay(field: NotionFieldSchema, value: NotionRecordValue): string {
  if (value == null) {
    return '-';
  }

  if (field.type === 'checkbox') {
    return value ? '是' : '否';
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join('，') : '-';
  }

  if (typeof value === 'object') {
    const date = value as NotionDateValue;
    return date.end ? `${date.start} ~ ${date.end}` : date.start || '-';
  }

  if (typeof value === 'string') {
    return value.trim() || '-';
  }

  return String(value);
}

function isFieldValueEmpty(value: NotionRecordValue | undefined): boolean {
  if (value == null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim() === '';
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === 'object') {
    const date = value as NotionDateValue;
    return !date.start?.trim() && !date.end?.trim();
  }

  return false;
}

function findActiveGroup(store: PresetGroupStore): PresetGroup | null {
  return store.groups.find((group) => group.id === store.activeGroupId) ?? store.groups[0] ?? null;
}

function findFieldForDomainKey(cache: NotionCacheSnapshot | null, domainKey: string): NotionFieldSchema | null {
  if (!cache || !domainKey) {
    return null;
  }

  return (
    cache.fields.find((field) => {
      const byLabel = normalizeDomainKeyInput(field.label);
      const byKey = normalizeDomainKeyInput(field.key);
      return byLabel === domainKey || byKey === domainKey;
    }) ?? null
  );
}

type AppProps = {
  rootElement: HTMLElement;
};

export default function App({ rootElement }: AppProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeTargetRef = useRef<EditableTarget | null>(null);
  const lastInputSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const lastContentRangeRef = useRef<Range | null>(null);
  const positionRef = useRef<PanelPosition>(getDefaultPosition());
  const isEditingRef = useRef(false);

  const [currentPageUrl, setCurrentPageUrl] = useState(window.location.href);
  const currentHostname = useMemo(() => extractHostname(currentPageUrl), [currentPageUrl]);

  const [presetStore, setPresetStoreState] = useState<PresetGroupStore>(DEFAULT_PRESET_GROUP_STORE);
  const [draftPresetStore, setDraftPresetStore] = useState<PresetGroupStore>(DEFAULT_PRESET_GROUP_STORE);
  const [newPresetGroupInput, setNewPresetGroupInput] = useState('');
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [position, setPosition] = useState<PanelPosition>(positionRef.current);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [notionConfig, setNotionConfigState] = useState<NotionConfig>({ apiKey: '', databaseId: '' });
  const [draftNotionConfig, setDraftNotionConfig] = useState<NotionConfig>({ apiKey: '', databaseId: '' });
  const [notionCache, setNotionCacheState] = useState<NotionCacheSnapshot | null>(null);
  const [notionSyncState, setNotionSyncStateState] = useState<NotionSyncState>(DEFAULT_NOTION_SYNC_STATE);
  const [notionMode, setNotionMode] = useState<NotionPanelMode>('view');
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [notionFormValues, setNotionFormValues] = useState<NotionFormValues>({});
  const [quickFieldInput, setQuickFieldInput] = useState('');
  const [isSubmittingNotion, setIsSubmittingNotion] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const noticeTimerRef = useRef<number | null>(null);

  const activePresetGroup = useMemo(() => findActiveGroup(presetStore), [presetStore]);
  const draftActivePresetGroup = useMemo(() => findActiveGroup(draftPresetStore), [draftPresetStore]);
  const presetItems = activePresetGroup?.items ?? [];

  const matchedRecord = useMemo(() => {
    if (!notionCache || !currentHostname || !notionCache.urlFieldKey) {
      return null;
    }

    return notionCache.records.find((record) => record.hostname === currentHostname) ?? null;
  }, [currentHostname, notionCache]);

  const editingRecord = useMemo(() => {
    if (!notionCache || !editingRecordId) {
      return null;
    }

    return notionCache.records.find((record) => record.id === editingRecordId) ?? null;
  }, [editingRecordId, notionCache]);

  const currentRecord = editingRecord ?? matchedRecord;

  const activeDomainKey = activePresetGroup?.domainKey ?? '';
  const activeKeyField = useMemo(
    () => findFieldForDomainKey(notionCache, activeDomainKey),
    [activeDomainKey, notionCache],
  );
  const activeKeyRecordField = currentRecord && activeKeyField ? currentRecord.fields[activeKeyField.key] : null;
  const canQuickUpdateKeyField = Boolean(
    currentRecord && activeKeyField && activeKeyField.writable && QUICK_UPDATE_TYPES.has(activeKeyField.type),
  );
  const isEditingExistingRecord = notionMode === 'edit' && Boolean(currentRecord);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    isEditingRef.current = editMode !== 'none';
  }, [editMode]);

  const applyNotionState = useCallback((cache: NotionCacheSnapshot | null, syncState: NotionSyncState) => {
    setNotionCacheState(cache);
    setNotionSyncStateState(syncState);
  }, []);

  function showNotice(text: string) {
    setNotice(text);
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 1400);
  }

  function showError(error: unknown) {
    setErrorMessage(getErrorMessage(error));
  }

  function clearError() {
    setErrorMessage('');
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [storedPresetStore, storedPosition, storedNotionConfig, storedNotionCache, storedNotionSyncState] =
          await Promise.all([
            getPresetGroupStore(),
            getPanelPosition(),
            getNotionConfig(),
            getNotionCache(),
            getNotionSyncState(),
          ]);

        if (cancelled) {
          return;
        }

        clearError();
        setPresetStoreState(storedPresetStore);
        setDraftPresetStore(clonePresetGroupStore(storedPresetStore));
        setNotionConfigState(storedNotionConfig);
        setDraftNotionConfig(cloneNotionConfig(storedNotionConfig));
        applyNotionState(storedNotionCache, storedNotionSyncState);

        if (storedPosition) {
          const panel = panelRef.current;
          const nextPosition = panel
            ? clampPosition(storedPosition, panel.offsetWidth, panel.offsetHeight)
            : storedPosition;
          positionRef.current = nextPosition;
          setPosition(nextPosition);
        }

        if (isNotionConfigComplete(storedNotionConfig)) {
          const payload = await requestNotionCache();
          if (!cancelled) {
            applyNotionState(payload.cache, payload.syncState);
          }
        }
      } catch (error) {
        if (!cancelled) {
          showError(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, [applyNotionState]);

  useEffect(() => {
    function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEYS.presetGroups]) {
        void (async () => {
          try {
            const latest = await getPresetGroupStore();
            clearError();
            setPresetStoreState(latest);
            if (!isEditingRef.current) {
              setDraftPresetStore(clonePresetGroupStore(latest));
            }
          } catch (error) {
            showError(error);
          }
        })();
      }

      if (changes[STORAGE_KEYS.notionApiKey] || changes[STORAGE_KEYS.notionDatabaseId]) {
        void (async () => {
          try {
            const latest = await getNotionConfig();
            setNotionConfigState(latest);
            if (!isEditingRef.current) {
              setDraftNotionConfig(cloneNotionConfig(latest));
            }
          } catch (error) {
            showError(error);
          }
        })();
      }

      if (changes[STORAGE_KEYS.notionCache]) {
        setNotionCacheState((changes[STORAGE_KEYS.notionCache].newValue as NotionCacheSnapshot | null) ?? null);
      }

      if (changes[STORAGE_KEYS.notionSyncState]) {
        setNotionSyncStateState(
          (changes[STORAGE_KEYS.notionSyncState].newValue as NotionSyncState | undefined) ??
            DEFAULT_NOTION_SYNC_STATE,
        );
      }
    }

    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  useEffect(() => {
    function updateActiveTarget(rawTarget: EventTarget | null) {
      if (rawTarget instanceof Node && rootElement.contains(rawTarget)) {
        return;
      }

      const target = resolveEditableTarget(rawTarget);
      if (!target) {
        return;
      }

      activeTargetRef.current = target;

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        lastInputSelectionRef.current = { start, end };
      }
    }

    function onFocusIn(event: FocusEvent) {
      updateActiveTarget(event.target);
    }

    function onPointerDown(event: PointerEvent) {
      updateActiveTarget(event.target);
    }

    function onSelectionChange() {
      const target = activeTargetRef.current;
      if (!target || !isContentEditableElement(target)) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      if (!target.contains(range.commonAncestorContainer)) {
        return;
      }

      lastContentRangeRef.current = range.cloneRange();
    }

    function onInputSelectionChange() {
      const target = activeTargetRef.current;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }

      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      lastInputSelectionRef.current = { start, end };
    }

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    document.addEventListener('keyup', onInputSelectionChange, true);
    document.addEventListener('click', onInputSelectionChange, true);

    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', onSelectionChange, true);
      document.removeEventListener('keyup', onInputSelectionChange, true);
      document.removeEventListener('click', onInputSelectionChange, true);
    };
  }, [rootElement]);

  useEffect(() => {
    function onResize() {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const next = clampPosition(positionRef.current, panel.offsetWidth, panel.offsetHeight);
      positionRef.current = next;
      setPosition(next);
    }

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function onWindowError(event: ErrorEvent) {
      showError(event.error ?? event.message);
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      showError(event.reason);
    }

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    function syncCurrentPageUrl(nextUrl: string) {
      setCurrentPageUrl((prev) => (prev === nextUrl ? prev : nextUrl));
    }

    function syncFromLocation() {
      syncCurrentPageUrl(window.location.href);
    }

    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    window.addEventListener('hashchange', syncFromLocation);

    const timer = window.setInterval(syncFromLocation, 300);

    return () => {
      window.removeEventListener('popstate', syncFromLocation);
      window.removeEventListener('hashchange', syncFromLocation);
      window.clearInterval(timer);
    };
  }, []);

  // When URL changes and no record exists, sync the URL field in the form
  useEffect(() => {
    const urlKey = notionCache?.urlFieldKey;
    if (!urlKey || currentRecord) return;
    setNotionFormValues((prev) => {
      if (prev[urlKey] === currentPageUrl) return prev;
      return { ...prev, [urlKey]: currentPageUrl };
    });
  }, [currentPageUrl, currentRecord, notionCache]);

  useEffect(() => {
    if (!notionCache) {
      setNotionMode('view');
      setEditingRecordId(null);
      setNotionFormValues({});
      return;
    }

    if (notionMode === 'edit') {
      if (!editingRecordId || !editingRecord) {
        setNotionMode('view');
        setEditingRecordId(null);
      }
      return;
    }

    if (matchedRecord) {
      if (notionMode === 'view') {
        setNotionFormValues(createFormValues(notionCache, matchedRecord, currentPageUrl));
      }
      return;
    }

    if (notionMode === 'view') {
      setNotionMode('create');
      setNotionFormValues(createFormValues(notionCache, null, currentPageUrl));
    }
  }, [currentPageUrl, editingRecord, editingRecordId, matchedRecord, notionCache, notionMode]);

  useEffect(() => {
    if (!currentRecord || !activeKeyField) {
      setQuickFieldInput('');
      return;
    }

    const fieldValue = currentRecord.fields[activeKeyField.key]?.value;
    setQuickFieldInput(typeof fieldValue === 'string' ? fieldValue : '');
  }, [activeKeyField, currentRecord]);

  const refreshNotion = useCallback(() => {
    if (!isNotionConfigComplete(notionConfig)) {
      return;
    }

    setNotionSyncStateState((prev) => ({ ...prev, isSyncing: true, lastError: '' }));

    void (async () => {
      try {
        const payload = await requestNotionSync();
        applyNotionState(payload.cache, payload.syncState);
      } catch (error) {
        setNotionSyncStateState((prev) => ({
          ...prev,
          isSyncing: false,
          lastError: getNotionErrorMessage(error),
        }));
      }
    })();
  }, [applyNotionState, notionConfig]);

  useEffect(() => {
    const notionConfigured = isNotionConfigComplete(notionConfig);
    if (!notionConfigured || notionCache || notionSyncState.isSyncing) {
      return;
    }

    refreshNotion();
  }, [notionCache, notionConfig, notionSyncState.isSyncing, refreshNotion]);

  function onDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const rawTarget = event.target as EventTarget | null;
    const triggerElement =
      rawTarget instanceof Element
        ? rawTarget
        : rawTarget instanceof Node
          ? rawTarget.parentElement
          : null;

    if (triggerElement?.closest('button, a, input, textarea, select')) {
      return;
    }

    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const base = positionRef.current;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextRaw: PanelPosition = {
        left: base.left + (moveEvent.clientX - startX),
        top: base.top + (moveEvent.clientY - startY),
      };

      const next = clampPosition(nextRaw, panel.offsetWidth, panel.offsetHeight);
      positionRef.current = next;
      setPosition(next);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      void setPanelPosition(positionRef.current);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function insertIntoEditable(text: string): boolean {
    const target = activeTargetRef.current;

    if (!target || !target.isConnected) {
      return false;
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();

      const fallback = target.value.length;
      const cached = lastInputSelectionRef.current;
      const start = target.selectionStart ?? cached?.start ?? fallback;
      const end = target.selectionEnd ?? cached?.end ?? fallback;

      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (isContentEditableElement(target)) {
      target.focus();
      const selection = window.getSelection();
      if (!selection) {
        return false;
      }

      let range: Range;

      if (
        lastContentRangeRef.current &&
        target.contains(lastContentRangeRef.current.commonAncestorContainer)
      ) {
        range = lastContentRangeRef.current.cloneRange();
      } else if (
        selection.rangeCount > 0 &&
        target.contains(selection.getRangeAt(0).commonAncestorContainer)
      ) {
        range = selection.getRangeAt(0).cloneRange();
      } else {
        range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
      }

      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);

      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      lastContentRangeRef.current = range.cloneRange();
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return false;
  }

  function onPresetClick(value: string) {
    const inserted = insertIntoEditable(value);
    if (!inserted) {
      showNotice('请先点击页面输入框');
      return;
    }

    showNotice('已填充');
  }

  function openEditMode(mode: EditMode) {
    clearError();
    setDraftPresetStore(clonePresetGroupStore(presetStore));
    setDraftNotionConfig(cloneNotionConfig(notionConfig));
    setNewPresetGroupInput('');
    setEditMode(mode);
  }

  function cancelEditing() {
    setDraftPresetStore(clonePresetGroupStore(presetStore));
    setDraftNotionConfig(cloneNotionConfig(notionConfig));
    setNewPresetGroupInput('');
    setEditMode('none');
  }

  async function savePresetStoreEditing(successNotice = '已保存') {
    try {
      await setPresetGroupStore(draftPresetStore);
      const refreshedPresetStore = await getPresetGroupStore();
      clearError();
      setPresetStoreState(refreshedPresetStore);
      setDraftPresetStore(clonePresetGroupStore(refreshedPresetStore));
      setEditMode('none');
      showNotice(successNotice);
    } catch (error) {
      showError(error);
    }
  }

  async function saveNotionSettings() {
    const nextNotionConfig = cloneNotionConfig(draftNotionConfig);

    try {
      await setNotionConfig(nextNotionConfig);
      const [refreshedNotionConfig, refreshedNotionCache, refreshedNotionSyncState] = await Promise.all([
        getNotionConfig(),
        getNotionCache(),
        getNotionSyncState(),
      ]);
      clearError();
      setNotionConfigState(refreshedNotionConfig);
      setDraftNotionConfig(cloneNotionConfig(refreshedNotionConfig));
      applyNotionState(refreshedNotionCache, refreshedNotionSyncState);
      setEditMode('none');
      showNotice('已保存');
    } catch (error) {
      showError(error);
    }
  }

  function selectPresetGroup(groupId: string) {
    const previousStore = presetStore;
    const nextStore = { ...presetStore, activeGroupId: groupId };
    setPresetStoreState(nextStore);
    void (async () => {
      try {
        await setPresetGroupStore(nextStore);
      } catch (error) {
        setPresetStoreState(previousStore);
        showError(error);
      }
    })();
  }

  function selectDraftPresetGroup(groupId: string) {
    setDraftPresetStore((prev) => ({ ...prev, activeGroupId: groupId }));
  }

  function addDraftPresetGroup() {
    const domainKey = normalizeDomainKeyInput(newPresetGroupInput);
    if (!domainKey) {
      showError('请输入有效的网站域名链接或域名。');
      return;
    }

    setDraftPresetStore((prev) => {
      const existing = prev.groups.find((group) => group.domainKey === domainKey || group.id === domainKey);
      if (existing) {
        return { ...prev, activeGroupId: existing.id };
      }

      const nextGroup = createPresetGroup(domainKey, []);
      return {
        groups: [...prev.groups, nextGroup],
        activeGroupId: nextGroup.id,
      };
    });
    setNewPresetGroupInput('');
    clearError();
  }

  function removeDraftPresetGroup(groupId: string) {
    setDraftPresetStore((prev) => {
      const remaining = prev.groups.filter((group) => group.id !== groupId);
      if (remaining.length === 0) {
        return createFallbackPresetGroupStore();
      }

      const nextActiveGroupId = prev.activeGroupId === groupId ? remaining[0].id : prev.activeGroupId;
      return {
        groups: remaining,
        activeGroupId: nextActiveGroupId,
      };
    });
  }

  function updateDraftKey(index: number, key: string) {
    const activeGroupId = draftPresetStore.activeGroupId;
    setDraftPresetStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? {
              ...group,
              items: group.items.map((item, itemIndex) =>
                itemIndex === index ? { ...item, key } : item,
              ),
            }
          : group,
      ),
    }));
  }

  function updateDraftValue(index: number, value: string) {
    const activeGroupId = draftPresetStore.activeGroupId;
    setDraftPresetStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? {
              ...group,
              items: group.items.map((item, itemIndex) =>
                itemIndex === index ? { ...item, value } : item,
              ),
            }
          : group,
      ),
    }));
  }

  function updateDraftNotionField(field: keyof NotionConfig, value: string) {
    setDraftNotionConfig((prev) => ({ ...prev, [field]: value }));
  }

  function addDraft() {
    const activeGroupId = draftPresetStore.activeGroupId;
    setDraftPresetStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId ? { ...group, items: [...group.items, { key: '', value: '' }] } : group,
      ),
    }));
  }

  function removeDraft(index: number) {
    const activeGroupId = draftPresetStore.activeGroupId;
    setDraftPresetStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? { ...group, items: group.items.filter((_, itemIndex) => itemIndex !== index) }
          : group,
      ),
    }));
  }

  function setNotionFieldValue(key: string, value: NotionRecordValue) {
    setNotionFormValues((prev) => ({ ...prev, [key]: value }));
  }

  function startCreateRecord() {
    if (!notionCache) {
      return;
    }

    setEditingRecordId(null);
    setNotionMode('create');
    setNotionFormValues(createFormValues(notionCache, null, currentPageUrl));
  }

  function startEditRecord() {
    if (!notionCache || !matchedRecord) {
      return;
    }

    setEditingRecordId(matchedRecord.id);
    setNotionMode('edit');
    setNotionFormValues(createFormValues(notionCache, matchedRecord, currentPageUrl));
  }

  function cancelNotionEdit() {
    if (!notionCache) {
      setNotionMode('view');
      setEditingRecordId(null);
      setNotionFormValues({});
      return;
    }

    setEditingRecordId(null);
    if (matchedRecord) {
      setNotionMode('view');
      setNotionFormValues(createFormValues(notionCache, matchedRecord, currentPageUrl));
      return;
    }

    setNotionMode('create');
    setNotionFormValues(createFormValues(notionCache, null, currentPageUrl));
  }

  async function submitNotionForm() {
    if (!notionCache) {
      return;
    }

    setIsSubmittingNotion(true);
    setNotionSyncStateState((prev) => ({ ...prev, lastError: '' }));

    try {
      const payload =
        isEditingExistingRecord && currentRecord
          ? await requestUpdateNotionRecord(currentRecord.id, notionFormValues)
          : await requestCreateNotionRecord(notionFormValues);

      applyNotionState(payload.cache, payload.syncState);
      setNotionMode('view');
      setEditingRecordId(null);
      showNotice(isEditingExistingRecord ? '已更新' : '已新增');
    } catch (error) {
      setNotionSyncStateState((prev) => ({
        ...prev,
        isSyncing: false,
        lastError: getNotionErrorMessage(error),
      }));
    } finally {
      setIsSubmittingNotion(false);
    }
  }

  async function submitQuickFieldUpdate() {
    if (!currentRecord || !activeKeyField || !canQuickUpdateKeyField) {
      return;
    }

    setIsSubmittingNotion(true);
    setNotionSyncStateState((prev) => ({ ...prev, lastError: '' }));

    try {
      const payload = await requestUpdateNotionRecord(currentRecord.id, {
        [activeKeyField.key]: quickFieldInput,
      });
      applyNotionState(payload.cache, payload.syncState);
      showNotice('已更新外链');
    } catch (error) {
      setNotionSyncStateState((prev) => ({
        ...prev,
        isSyncing: false,
        lastError: getNotionErrorMessage(error),
      }));
    } finally {
      setIsSubmittingNotion(false);
    }
  }

  function roamToNextUnfilled() {
    if (!notionCache || !activeKeyField || !notionCache.urlFieldKey) {
      showNotice('无法漫游');
      return;
    }

    const urlFieldKey = notionCache.urlFieldKey;
    const spamFieldKey = getSpamFieldKey(notionCache);

    const currentIdentity = getRoamUrlIdentity(currentPageUrl);
    const currentTargetUrl = getRoamTargetUrl(currentPageUrl);

    const candidates = notionCache.records
      .filter((record) => {
        const keyField = record.fields[activeKeyField.key];
        if (!isFieldValueEmpty(keyField?.value)) {
          return false;
        }

        const spamField = spamFieldKey ? record.fields[spamFieldKey] : null;
        if (spamField && isSpamValue(spamField.value)) {
          return false;
        }

        return true;
      })
      .map((record) => {
        const urlField = record.fields[urlFieldKey];
        const rawUrl = typeof urlField?.value === 'string' ? urlField.value.trim() : '';
        const targetUrl = getRoamTargetUrl(rawUrl);
        if (!targetUrl) {
          return null;
        }

        return {
          targetUrl,
          identity: getRoamUrlIdentity(rawUrl),
        };
      })
      .filter((item): item is { targetUrl: string; identity: string | null } => Boolean(item));

    if (candidates.length === 0) {
      showNotice(`列 ${activeKeyField.label} 没有待处理外链记录`);
      return;
    }

    const currentIndex = candidates.findIndex((item) => {
      if (currentIdentity && item.identity) {
        return item.identity === currentIdentity;
      }
      if (currentTargetUrl) {
        return item.targetUrl === currentTargetUrl;
      }
      return false;
    });

    const nextItem = currentIndex >= 0 ? candidates[(currentIndex + 1) % candidates.length] : candidates[0];
    const isSameAsCurrent = (currentIdentity && nextItem.identity && nextItem.identity === currentIdentity)
      || (currentTargetUrl && nextItem.targetUrl === currentTargetUrl);

    if (isSameAsCurrent) {
      showNotice(`列 ${activeKeyField.label} 没有其他待处理外链记录`);
      return;
    }

    window.open(nextItem.targetUrl, '_blank');
    showNotice('已跳转到: ' + nextItem.targetUrl.substring(0, 50));
  }

  function renderFieldInput(field: NotionFieldSchema) {
    const value = notionFormValues[field.key] ?? null;
    const disabled = isSubmittingNotion || !field.writable;

    if (!field.writable) {
      return <div className="qpf-record-readonly">{getFieldDisplay(field, value)}</div>;
    }

    switch (field.type) {
      case 'title':
      case 'rich_text':
        return (
          <textarea
            className="qpf-textarea"
            rows={field.type === 'title' ? 2 : 3}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => setNotionFieldValue(field.key, event.target.value)}
          />
        );
      case 'number':
        return (
          <input
            className="qpf-key-input"
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value.trim();
              setNotionFieldValue(field.key, next ? Number(next) : null);
            }}
          />
        );
      case 'checkbox':
        return (
          <label className="qpf-checkbox-field">
            <input
              type="checkbox"
              checked={Boolean(value)}
              disabled={disabled}
              onChange={(event) => setNotionFieldValue(field.key, event.target.checked)}
            />
            <span>{Boolean(value) ? '是' : '否'}</span>
          </label>
        );
      case 'select':
      case 'status':
        return field.options && field.options.length > 0 ? (
          <select
            className="qpf-key-input"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => setNotionFieldValue(field.key, event.target.value)}
          >
            <option value="">未选择</option>
            {field.options.map((option) => (
              <option key={`${field.key}-${option.name}`} value={option.name}>
                {option.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="qpf-key-input"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => setNotionFieldValue(field.key, event.target.value)}
          />
        );
      case 'multi_select':
        return (
          <input
            className="qpf-key-input"
            value={Array.isArray(value) ? value.join('，') : ''}
            disabled={disabled}
            placeholder="多个值请用逗号分隔"
            onChange={(event) => {
              const next = event.target.value
                .split(/[,，]/)
                .map((item) => item.trim())
                .filter(Boolean);
              setNotionFieldValue(field.key, next);
            }}
          />
        );
      case 'date': {
        const dateValue = value && typeof value === 'object' && !Array.isArray(value) ? (value as NotionDateValue) : null;
        return (
          <div className="qpf-date-grid">
            <input
              className="qpf-key-input"
              value={dateValue?.start ?? ''}
              disabled={disabled}
              placeholder="开始日期，例如 2026-04-23"
              onChange={(event) =>
                setNotionFieldValue(field.key, {
                  start: event.target.value,
                  end: dateValue?.end ?? '',
                })
              }
            />
            <input
              className="qpf-key-input"
              value={dateValue?.end ?? ''}
              disabled={disabled}
              placeholder="结束日期（可选）"
              onChange={(event) =>
                setNotionFieldValue(field.key, {
                  start: dateValue?.start ?? '',
                  end: event.target.value,
                })
              }
            />
          </div>
        );
      }
      default:
        return (
          <input
            className="qpf-key-input"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => setNotionFieldValue(field.key, event.target.value)}
          />
        );
    }
  }

  const notionConfigured = isNotionConfigComplete(notionConfig);
  const notionStatusText = getNotionStatusText(notionConfigured, notionSyncState, notionCache);
  const notionError = notionSyncState.lastError;
  const missingUrlField = notionCache && !notionCache.urlFieldKey;

  return (
    <div
      ref={panelRef}
      className={`qpf-panel${isCollapsed ? ' qpf-panel-collapsed' : ''}`}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <div className="qpf-header" onPointerDown={onDragStart}>
        <span className="qpf-title">Hacker Extension</span>
        <div className="qpf-header-actions">
          <button
            type="button"
            className="qpf-collapse-btn"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? '展开' : '折叠'}
          >
            {isCollapsed ? '▼' : '▲'}
          </button>
        </div>
      </div>

      {errorMessage ? <div className="qpf-error">{errorMessage}</div> : null}

      {!isCollapsed && (
        <div className="qpf-body">
        <section className="qpf-section qpf-top-tabs">
          <div className="qpf-section-head">
            <div>
              <div className="qpf-section-title">网站选择</div>
            </div>
            {editMode === 'tabs' ? (
              <div className="qpf-inline-actions">
                <button type="button" className="qpf-mini-btn" onClick={() => void savePresetStoreEditing('已保存')}>
                  保存
                </button>
                <button type="button" className="qpf-mini-btn qpf-cancel-btn" onClick={cancelEditing}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" className="qpf-mini-btn" onClick={() => openEditMode('tabs')}>
                设置
              </button>
            )}
          </div>

          <div className="qpf-tab-list">
            {(editMode === 'tabs' ? draftPresetStore : presetStore).groups.map((group) => (
              <button
                type="button"
                key={group.id}
                className={`qpf-tab ${
                  group.id === (editMode === 'tabs' ? draftPresetStore.activeGroupId : presetStore.activeGroupId)
                    ? 'is-active'
                    : ''
                }`}
                onClick={() =>
                  editMode === 'tabs' ? selectDraftPresetGroup(group.id) : selectPresetGroup(group.id)
                }
              >
                {group.label}
              </button>
            ))}
          </div>

          {editMode === 'tabs' ? (
            <div className="qpf-tab-settings">
              <div className="qpf-domain-create">
                <input
                  className="qpf-key-input"
                  value={newPresetGroupInput}
                  onChange={(event) => setNewPresetGroupInput(event.target.value)}
                  placeholder="输入网站域名，如 https://example.com"
                />
                <button type="button" className="qpf-mini-btn" onClick={addDraftPresetGroup}>
                  添加网站
                </button>
              </div>
              {draftActivePresetGroup ? (
                <div className="qpf-tab-settings-footer">
                  <div className="qpf-page-host">正在编辑：{draftActivePresetGroup.label}</div>
                  <button
                    type="button"
                    className="qpf-mini-btn qpf-danger-btn"
                    onClick={() => removeDraftPresetGroup(draftActivePresetGroup.id)}
                  >
                    删除
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="qpf-section">
          <div className="qpf-section-head">
            <div>
              <div className="qpf-section-title">
                外链
                {notionCache && <span className="qpf-record-count"> · {notionCache.rowCount} 条记录</span>}
              </div>
              <div className="qpf-section-subtitle">{notionStatusText}</div>
            </div>
            {notionConfigured ? (
              <div className="qpf-inline-actions">
                <button
                  type="button"
                  className="qpf-mini-btn"
                  onClick={refreshNotion}
                  disabled={notionSyncState.isSyncing || isSubmittingNotion}
                >
                  {notionSyncState.isSyncing ? '同步中' : '刷新'}
                </button>
                <button
                  type="button"
                  className="qpf-mini-btn"
                  onClick={roamToNextUnfilled}
                  disabled={!notionCache || !activeKeyField}
                >
                  外链漫游
                </button>
              </div>
            ) : null}
          </div>


          {!notionConfigured ? (
            <div className="qpf-empty">请先在下方「Notion 配置」中填写 API Key 和 Database ID。</div>
          ) : notionSyncState.isSyncing && !notionCache ? (
            <div className="qpf-state">正在读取 Notion 数据...</div>
          ) : notionError && !notionCache ? (
            <div className="qpf-error qpf-error-inline">{notionError}</div>
          ) : !notionCache ? (
            <div className="qpf-state">首次无缓存时会自动同步一次。</div>
          ) : missingUrlField ? (
            <div className="qpf-error qpf-error-inline">当前数据库里没有列名为 URL 的字段，无法按域名匹配记录。</div>
          ) : (
            <div className="qpf-record-wrap">
              {notionError ? <div className="qpf-error qpf-error-inline">{notionError}</div> : null}

              {currentRecord ? (
                <div className="qpf-key-link-box">
                  <div className="qpf-section-head">
                    <div>
                      <div className="qpf-section-title">外链状态</div>
                      <div className={`qpf-section-subtitle${!activeKeyRecordField?.display || activeKeyRecordField.display === '-' ? ' qpf-text-green' : ''}`}>
                        {activeKeyRecordField?.display && activeKeyRecordField.display !== '-'
                          ? '已经处理过该外链'
                          : '当前网站还没加过这个外链'}
                      </div>
                    </div>
                  </div>
                  {activeKeyField ? (
                    <>
                      <div className="qpf-record-row">
                        <div className="qpf-record-label">备注</div>
                        <div className="qpf-record-value">{activeKeyRecordField?.display || '-'}</div>
                      </div>
                      {canQuickUpdateKeyField ? (
                        <div className="qpf-domain-create">
                          <input
                            className="qpf-key-input"
                            value={quickFieldInput}
                            onChange={(event) => setQuickFieldInput(event.target.value)}
                            placeholder="输入外链后快速更新"
                            disabled={isSubmittingNotion}
                          />
                          <button
                            type="button"
                            className="qpf-mini-btn"
                            onClick={() => void submitQuickFieldUpdate()}
                            disabled={isSubmittingNotion}
                          >
                            {isSubmittingNotion ? '更新中' : '更新'}
                          </button>
                        </div>
                      ) : activeKeyField ? (
                        <div className="qpf-empty">该字段类型不支持快捷更新。</div>
                      ) : null}
                    </>
                  ) : (
                    <div className="qpf-empty">对应的 Notion 列不存在。</div>
                  )}
                </div>
              ) : null}

              {currentRecord && notionMode === 'view' ? (
                <>
                  <div className="qpf-section-head qpf-margin-top">
                    <div>
                      <div className="qpf-section-title">已经收录该外链</div>
                      <div className="qpf-section-subtitle">域名：{currentRecord.hostname}</div>
                    </div>
                    <button type="button" className="qpf-mini-btn" onClick={startEditRecord}>
                      编辑
                    </button>
                  </div>
                  <div className="qpf-record-list">
                    {(() => {
                      const fields = notionCache.fields;
                      const sortedFields = [...fields].sort((a, b) => {
                        const aIsUrlKey = a.key === notionCache.urlFieldKey ? 0 : 1;
                        const bIsUrlKey = b.key === notionCache.urlFieldKey ? 0 : 1;
                        if (aIsUrlKey !== bIsUrlKey) return aIsUrlKey - bIsUrlKey;
                        const aLabel = a.label.toLowerCase();
                        const bLabel = b.label.toLowerCase();
                        const aIsDomainLike = a.type === 'url' || aLabel.includes('http') || aLabel === 'url' || aLabel === 'domain' || aLabel === 'hostname';
                        const bIsDomainLike = b.type === 'url' || bLabel.includes('http') || bLabel === 'url' || bLabel === 'domain' || bLabel === 'hostname';
                        if (aIsDomainLike !== bIsDomainLike) return aIsDomainLike ? 1 : -1;
                        return 0;
                      });
                      return sortedFields.map((field) => {
                        const recordField = currentRecord.fields[field.key];
                        return (
                          <div className="qpf-record-row" key={field.key}>
                            <div className="qpf-record-label">{field.label}</div>
                            <div className="qpf-record-value" title={recordField?.display || '-'}>
                              {recordField?.display || '-'}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </>
              ) : (
                <>
                  <div className="qpf-section-head">
                    <div>
                      <div className="qpf-section-title qpf-golden-text">
                        {isEditingExistingRecord ? '编辑记录' : '这是一个新的外链'}
                      </div>
                      <div className="qpf-section-subtitle">
                        {isEditingExistingRecord ? '修改后自动更新 Notion' : `为 ${currentHostname} 填写外链信息`}
                      </div>
                    </div>
                    {isEditingExistingRecord ? (
                      <button
                        type="button"
                        className="qpf-mini-btn qpf-cancel-btn"
                        onClick={cancelNotionEdit}
                        disabled={isSubmittingNotion}
                      >
                        取消
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="qpf-mini-btn qpf-cancel-btn"
                        onClick={startCreateRecord}
                        disabled={isSubmittingNotion}
                      >
                        重置
                      </button>
                    )}
                  </div>

                  {!matchedRecord ? null : null}

                  <div className="qpf-record-form">
                    {(() => {
                      const fields = notionCache.fields;
                      const sortedFields = [...fields].sort((a, b) => {
                        const aIsUrlKey = a.key === notionCache.urlFieldKey ? 0 : 1;
                        const bIsUrlKey = b.key === notionCache.urlFieldKey ? 0 : 1;
                        if (aIsUrlKey !== bIsUrlKey) return aIsUrlKey - bIsUrlKey;
                        const aLabel = a.label.toLowerCase();
                        const bLabel = b.label.toLowerCase();
                        const aIsDomainLike = a.type === 'url' || aLabel.includes('http') || aLabel === 'url' || aLabel === 'domain' || aLabel === 'hostname';
                        const bIsDomainLike = b.type === 'url' || bLabel.includes('http') || bLabel === 'url' || bLabel === 'domain' || bLabel === 'hostname';
                        if (aIsDomainLike !== bIsDomainLike) return aIsDomainLike ? 1 : -1;
                        const aIsCompact = a.type === 'number' || a.type === 'select';
                        const bIsCompact = b.type === 'number' || b.type === 'select';
                        if (aIsCompact !== bIsCompact) return aIsCompact ? -1 : 1;
                        return 0;
                      });

                      const elements: React.ReactNode[] = [];
                      let i = 0;
                      while (i < sortedFields.length) {
                        const field = sortedFields[i];
                        const isCompact = field.type === 'number' || field.type === 'select';
                        if (isCompact && i + 1 < sortedFields.length) {
                          const nextField = sortedFields[i + 1];
                          const nextIsCompact = nextField.type === 'number' || nextField.type === 'select';
                          if (nextIsCompact) {
                            elements.push(
                              <div className="qpf-fields-row" key={`row-${i}`}>
                                <label className="qpf-field qpf-field-compact">
                                  <span className="qpf-field-label">
                                    {field.label}
                                    {!field.writable ? '（只读）' : ''}
                                  </span>
                                  {renderFieldInput(field)}
                                </label>
                                <label className="qpf-field qpf-field-compact">
                                  <span className="qpf-field-label">
                                    {nextField.label}
                                    {!nextField.writable ? '（只读）' : ''}
                                  </span>
                                  {renderFieldInput(nextField)}
                                </label>
                              </div>
                            );
                            i += 2;
                            continue;
                          }
                        }
                        elements.push(
                          <label className="qpf-field" key={field.key}>
                            <span className="qpf-field-label">
                              {field.label}
                              {!field.writable ? '（只读）' : ''}
                            </span>
                            {renderFieldInput(field)}
                          </label>
                        );
                        i++;
                      }
                      return elements;
                    })()}
                  </div>

                  <div className="qpf-record-actions">
                    <button
                      type="button"
                      className="qpf-mini-btn"
                      onClick={() => void submitNotionForm()}
                      disabled={isSubmittingNotion}
                    >
                      {isSubmittingNotion ? '提交中' : isEditingExistingRecord ? '保存修改' : '创建记录'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section className="qpf-section">
          <div className="qpf-section-head">
            <div>
              <div className="qpf-section-title">预设文本</div>
            </div>
            {editMode === 'presets' ? (
              <div className="qpf-inline-actions">
                <button type="button" className="qpf-mini-btn" onClick={() => void savePresetStoreEditing('已保存')}>
                  保存
                </button>
                <button type="button" className="qpf-mini-btn qpf-cancel-btn" onClick={cancelEditing}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" className="qpf-mini-btn" onClick={() => openEditMode('presets')}>
                设置
              </button>
            )}
          </div>

          {editMode === 'presets' ? (
            <div className="qpf-edit-wrap qpf-edit-wrap-inline">
              <div className="qpf-edit-list">
                {(draftActivePresetGroup?.items ?? []).map((item, index) => (
                  <div className="qpf-edit-row" key={index}>
                    <div className="qpf-edit-fields">
                      <input
                        className="qpf-key-input"
                        value={item.key}
                        onChange={(event) => updateDraftKey(index, event.target.value)}
                        placeholder="名称（如：地址）"
                      />
                      <textarea
                        className="qpf-textarea"
                        value={item.value}
                        onChange={(event) => updateDraftValue(index, event.target.value)}
                        rows={2}
                        placeholder="内容（点击时填充）"
                      />
                    </div>
                    <button type="button" className="qpf-mini-btn" onClick={() => removeDraft(index)}>
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="qpf-edit-actions">
                <button type="button" className="qpf-mini-btn" onClick={addDraft}>
                  添加文本
                </button>
              </div>
            </div>
          ) : (
            <div className="qpf-list">
              {presetItems.length === 0 ? (
                <div className="qpf-empty">暂无预设文本，点击「设置」添加</div>
              ) : (
                presetItems.map((item, index) => (
                  <button
                    type="button"
                    key={`${item.key}-${item.value}-${index}`}
                    className="qpf-item"
                    onClick={() => onPresetClick(item.value)}
                    title={`${item.key}: ${item.value}`}
                  >
                    <div className="qpf-item-key">{item.key}</div>
                    <div className="qpf-item-value">{item.value}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </section>

        <section className="qpf-section">
          <div className="qpf-section-head">
            <div>
              <div className="qpf-section-title">Notion 配置</div>
              <div className="qpf-section-subtitle">独立配置，与网站选择分开</div>
            </div>
            {editMode === 'notion' ? (
              <div className="qpf-inline-actions">
                <button type="button" className="qpf-mini-btn" onClick={() => void saveNotionSettings()}>
                  保存
                </button>
                <button type="button" className="qpf-mini-btn qpf-cancel-btn" onClick={cancelEditing}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" className="qpf-mini-btn" onClick={() => openEditMode('notion')}>
                设置
              </button>
            )}
          </div>

          {editMode === 'notion' ? (
            <div className="qpf-notion-form">
              <label className="qpf-field">
                <span className="qpf-field-label">API Key</span>
                <input
                  className="qpf-key-input"
                  type="password"
                  value={draftNotionConfig.apiKey}
                  onChange={(event) => updateDraftNotionField('apiKey', event.target.value)}
                  placeholder="secret_xxx"
                  autoComplete="off"
                />
              </label>
              <label className="qpf-field">
                <span className="qpf-field-label">Database ID</span>
                <input
                  className="qpf-key-input"
                  value={draftNotionConfig.databaseId}
                  onChange={(event) => updateDraftNotionField('databaseId', event.target.value)}
                  placeholder="输入 Notion 数据库 ID"
                  autoComplete="off"
                />
              </label>
            </div>
          ) : (
            <div className="qpf-state">敏感配置已隐藏，点击「设置」修改。</div>
          )}
        </section>
      </div>
      )}

      <div className="qpf-notice">{notice}</div>
    </div>
  );
}
