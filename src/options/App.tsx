import { useEffect, useMemo, useState } from 'react';
import { extractHostname } from '../shared/notion';
import {
  getPanelHiddenDomains,
  getPresetGroupStore,
  setPanelHiddenDomains,
  setPresetGroupStore,
} from '../shared/storage';
import {
  DEFAULT_PRESET_GROUP_STORE,
  DEFAULT_PRESET_ITEMS,
  type PresetGroup,
  type PresetGroupStore,
  type PresetItem,
} from '../shared/types';

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

function parseHiddenDomainsInput(value: string): string[] {
  const deduped = new Set<string>();
  for (const line of value.split('\n')) {
    const normalized = normalizeDomainKeyInput(line);
    if (!normalized) {
      continue;
    }

    deduped.add(normalized);
  }

  return [...deduped];
}

function formatHiddenDomainsInput(domains: string[]): string {
  return domains.join('\n');
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

function findActiveGroup(store: PresetGroupStore): PresetGroup | null {
  return store.groups.find((group) => group.id === store.activeGroupId) ?? store.groups[0] ?? null;
}

export default function App() {
  const [store, setStore] = useState<PresetGroupStore>(DEFAULT_PRESET_GROUP_STORE);
  const [newGroupInput, setNewGroupInput] = useState('');
  const [hiddenDomainsInput, setHiddenDomainsInput] = useState('');
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const activeGroup = useMemo(() => findActiveGroup(store), [store]);

  useEffect(() => {
    void (async () => {
      try {
        const [presetStore, hiddenDomains] = await Promise.all([getPresetGroupStore(), getPanelHiddenDomains()]);
        setStore(clonePresetGroupStore(presetStore));
        setHiddenDomainsInput(formatHiddenDomainsInput(hiddenDomains));
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '读取分组失败');
      }
    })();
  }, []);

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(''), 1200);
  }

  function clearMessages() {
    setNotice('');
    setErrorMessage('');
  }

  function selectGroup(groupId: string) {
    setStore((prev) => ({ ...prev, activeGroupId: groupId }));
    clearMessages();
  }

  function addGroup() {
    const domainKey = normalizeDomainKeyInput(newGroupInput);
    if (!domainKey) {
      setErrorMessage('请输入有效的网站域名链接或域名。');
      return;
    }

    setStore((prev) => {
      const existing = prev.groups.find((group) => group.id === domainKey || group.domainKey === domainKey);
      if (existing) {
        return { ...prev, activeGroupId: existing.id };
      }

      const nextGroup = createPresetGroup(domainKey);
      return {
        groups: [...prev.groups, nextGroup],
        activeGroupId: nextGroup.id,
      };
    });
    setNewGroupInput('');
    clearMessages();
  }

  function removeActiveGroup() {
    const groupId = activeGroup?.id;
    if (!groupId) {
      return;
    }

    setStore((prev) => {
      const remaining = prev.groups.filter((group) => group.id !== groupId);
      if (remaining.length === 0) {
        return createFallbackPresetGroupStore();
      }

      return {
        groups: remaining,
        activeGroupId: prev.activeGroupId === groupId ? remaining[0].id : prev.activeGroupId,
      };
    });
    clearMessages();
  }

  function updateKey(index: number, key: string) {
    const activeGroupId = store.activeGroupId;
    setStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? {
              ...group,
              items: group.items.map((item, itemIndex) => (itemIndex === index ? { ...item, key } : item)),
            }
          : group,
      ),
    }));
    clearMessages();
  }

  function updateValue(index: number, value: string) {
    const activeGroupId = store.activeGroupId;
    setStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? {
              ...group,
              items: group.items.map((item, itemIndex) => (itemIndex === index ? { ...item, value } : item)),
            }
          : group,
      ),
    }));
    clearMessages();
  }

  function addItem() {
    const activeGroupId = store.activeGroupId;
    setStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId ? { ...group, items: [...group.items, { key: '', value: '' }] } : group,
      ),
    }));
    clearMessages();
  }

  function removeItem(index: number) {
    const activeGroupId = store.activeGroupId;
    setStore((prev) => ({
      ...prev,
      groups: prev.groups.map((group) =>
        group.id === activeGroupId
          ? { ...group, items: group.items.filter((_, itemIndex) => itemIndex !== index) }
          : group,
      ),
    }));
    clearMessages();
  }

  async function save() {
    try {
      const parsedHiddenDomains = parseHiddenDomainsInput(hiddenDomainsInput);
      await Promise.all([setPresetGroupStore(store), setPanelHiddenDomains(parsedHiddenDomains)]);
      const [latestStore, latestHiddenDomains] = await Promise.all([getPresetGroupStore(), getPanelHiddenDomains()]);
      setStore(clonePresetGroupStore(latestStore));
      setHiddenDomainsInput(formatHiddenDomainsInput(latestHiddenDomains));
      setErrorMessage('');
      showNotice('已保存');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '保存失败');
    }
  }

  return (
    <main className="options-page">
      <section className="options-card">
        <h1>预设分组文本</h1>
        <p className="hint">每个 tab 绑定一个域名 key，不同分组的快捷文本会隔离存储并跨页面共享。</p>

        {errorMessage ? <div className="error-message">{errorMessage}</div> : null}

        <div className="group-toolbar">
          <div className="group-input-wrap">
            <input
              value={newGroupInput}
              onChange={(event) => setNewGroupInput(event.target.value)}
              placeholder="输入域名或链接，例如 https://example.com"
            />
            <button type="button" onClick={addGroup}>
              新增分组
            </button>
          </div>
          <button type="button" className="danger" onClick={removeActiveGroup} disabled={!activeGroup}>
            删除当前分组
          </button>
        </div>

        <div className="tab-list">
          {store.groups.map((group) => (
            <button
              type="button"
              key={group.id}
              className={`tab ${group.id === store.activeGroupId ? 'active' : ''}`}
              onClick={() => selectGroup(group.id)}
            >
              {group.label}
            </button>
          ))}
        </div>

        <div className="active-group-meta">
          <div>当前分组：{activeGroup?.label ?? '未选择'}</div>
          <div>域名 key：{activeGroup?.domainKey ?? '-'}</div>
        </div>

        <div className="list">
          {(activeGroup?.items ?? []).map((item, index) => (
            <div key={index} className="row">
              <div className="kv-fields">
                <input
                  value={item.key}
                  onChange={(event) => updateKey(index, event.target.value)}
                  placeholder="key，例如：地址"
                />
                <textarea
                  value={item.value}
                  onChange={(event) => updateValue(index, event.target.value)}
                  placeholder="value，点击时会填充此内容"
                  rows={2}
                />
              </div>
              <button type="button" className="danger" onClick={() => removeItem(index)}>
                删除
              </button>
            </div>
          ))}
          {(activeGroup?.items ?? []).length === 0 ? <div className="empty-state">当前分组还没有快捷文本。</div> : null}
        </div>

        <section className="hidden-domains-card">
          <h2>隐藏悬浮窗域名</h2>
          <p className="hint">一行一个域名或链接，命中后该网站不会展示悬浮窗（含子域名）。</p>
          <textarea
            value={hiddenDomainsInput}
            onChange={(event) => setHiddenDomainsInput(event.target.value)}
            placeholder={'example.com\nhttps://sub.example.org/path'}
            rows={6}
          />
        </section>

        <div className="actions">
          <button type="button" onClick={addItem} disabled={!activeGroup}>
            新增一条
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            保存
          </button>
        </div>

        <div className="notice">{notice}</div>
      </section>
    </main>
  );
}
