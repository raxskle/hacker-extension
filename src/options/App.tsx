import { useEffect, useMemo, useState } from 'react';
import { extractHostname } from '../shared/notion';
import {
  getPanelHiddenDomains,
  getPresetGroupStore,
  getSimProxyBridgeConfig,
  setPanelHiddenDomains,
  setPresetGroupStore,
  setSimProxyBridgeConfig,
} from '../shared/storage';
import {
  DEFAULT_PRESET_GROUP_STORE,
  DEFAULT_PRESET_ITEMS,
  DEFAULT_SIM_PROXY_BRIDGE_CONFIG,
  type PresetGroup,
  type PresetGroupStore,
  type PresetItem,
  type SimProxyBridgeConfig,
} from '../shared/types';
import {
  requestSimProxyStatus,
  requestSimProxyWakeup,
  type SimProxyBridgeStatusPayload,
  type SimProxyStatusLevel,
} from '../shared/simProxy';
import {
  parseNativeHostError,
  requestNativeHostStart,
  requestNativeHostStatus,
  requestNativeHostStop,
  type NativeHostAction,
  type NativeHostState,
} from '../shared/nativeHost';

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

function formatNativeHostStatus(state: NativeHostState | null): string {
  if (!state) {
    return '未检查';
  }

  return state.running ? `运行中（PID: ${state.pid ?? '-'}）` : '未运行';
}

function getNativeHostActionLabel(action: NativeHostAction): string {
  if (action === 'start') {
    return '启动';
  }

  if (action === 'stop') {
    return '停止';
  }

  return '检查状态';
}

function formatNativeHostActionError(action: NativeHostAction, error: unknown): string {
  const parsed = parseNativeHostError(error, action);
  const label = getNativeHostActionLabel(parsed.action);

  const suggestionByCode: Record<string, string> = {
    INSTALL_MISSING: '请先复制并执行安装命令，然后重启浏览器再重试。',
    NODE_MISSING: '请先安装 Node.js，再重新执行安装命令。',
    HOST_EXITED: '请先执行安装命令并检查本机 Node 环境。',
    PERMISSION_OR_PATH: '请检查本地目录权限后重新安装 Native host。',
    SERVICE_PATH_MISSING: '请确认插件目录完整，重新安装后再试。',
    SERVICE_SPAWN_FAILED: '请检查端口占用或系统权限后重试。',
    SERVICE_STARTUP_FAILED: '请检查端口占用，并查看日志 ~/.hacker-extension-native/bridge.log。',
    STATUS_UNAVAILABLE: '请重试；若持续失败，请重新安装 Native host。',
    STOP_FAILED: '请重试停止；必要时手动结束 PID 进程。',
    HOST_RESPONSE_INVALID: '请重新安装插件和 Native host 后重试。',
  };

  const suggestion = parsed.hint || suggestionByCode[parsed.code] || '请查看错误信息后重试。';
  return `${label}失败（${parsed.code}）：${parsed.message} 建议：${suggestion}`;
}

function formatStatusTime(value: number | null): string {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleString();
}

function formatStatusCount(value: number | null): string {
  return typeof value === 'number' ? String(value) : '-';
}

function getLevelClassName(level: SimProxyStatusLevel): 'ok' | 'warn' | 'error' {
  if (level === 'warn' || level === 'error') {
    return level;
  }

  return 'ok';
}

function getLevelLabel(level: SimProxyStatusLevel): string {
  if (level === 'warn') {
    return '告警';
  }

  if (level === 'error') {
    return '异常';
  }

  return '正常';
}

function renderStatusRow(label: string, value: string) {
  return (
    <div className="bridge-status-row">
      <span className="bridge-status-label">{label}</span>
      <span className="bridge-status-value">{value}</span>
    </div>
  );
}

export default function App() {
  const [store, setStore] = useState<PresetGroupStore>(DEFAULT_PRESET_GROUP_STORE);
  const [newGroupInput, setNewGroupInput] = useState('');
  const [hiddenDomainsInput, setHiddenDomainsInput] = useState('');
  const [simProxyConfig, setSimProxyConfig] = useState<SimProxyBridgeConfig>(DEFAULT_SIM_PROXY_BRIDGE_CONFIG);
  const [nativeState, setNativeState] = useState<NativeHostState | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [simProxyStatus, setSimProxyStatus] = useState<SimProxyBridgeStatusPayload | null>(null);
  const [simProxyBusy, setSimProxyBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const activeGroup = useMemo(() => findActiveGroup(store), [store]);
  const nativeInstallCommand = useMemo(
    () => `npm run native:install:mac -- --extension-id=${chrome.runtime.id}`,
    [],
  );

  async function refreshNativeStatus(options?: { silent?: boolean; showNotice?: boolean }) {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStatus();
      setNativeState(payload.state);
      if (!options?.silent) {
        setErrorMessage('');
      }
      if (options?.showNotice) {
        showNotice(payload.state.running ? '本地服务运行中' : '本地服务未运行');
      }
    } catch (error) {
      setNativeState(null);
      if (!options?.silent) {
        setErrorMessage(formatNativeHostActionError('status', error));
      }
    } finally {
      setNativeBusy(false);
    }
  }

  async function refreshSimProxyStatus(options?: { silent?: boolean; showNotice?: boolean }) {
    try {
      setSimProxyBusy(true);
      const payload = await requestSimProxyStatus();
      setSimProxyStatus(payload);
      if (!options?.silent) {
        setErrorMessage('');
      }
      if (options?.showNotice) {
        showNotice(`链路检查完成：${getLevelLabel(payload.level)}`);
      }
    } catch (error) {
      setSimProxyStatus(null);
      if (!options?.silent) {
        setErrorMessage(error instanceof Error ? error.message : '链路状态检查失败');
      }
    } finally {
      setSimProxyBusy(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [presetStore, hiddenDomains, bridgeConfig] = await Promise.all([
          getPresetGroupStore(),
          getPanelHiddenDomains(),
          getSimProxyBridgeConfig(),
        ]);
        setStore(clonePresetGroupStore(presetStore));
        setHiddenDomainsInput(formatHiddenDomainsInput(hiddenDomains));
        setSimProxyConfig(bridgeConfig);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '读取分组失败');
      }

      await Promise.all([refreshNativeStatus({ silent: true }), refreshSimProxyStatus({ silent: true })]);
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

  function updateBridgeBaseUrl(baseUrl: string) {
    setSimProxyConfig((prev) => ({ ...prev, baseUrl }));
    clearMessages();
  }

  function updateAutoMaintainExecutors(enabled: boolean) {
    setSimProxyConfig((prev) => ({ ...prev, autoMaintainExecutors: enabled }));
    clearMessages();
  }

  function updatePinExecutorTabs(enabled: boolean) {
    setSimProxyConfig((prev) => ({ ...prev, pinExecutorTabs: enabled }));
    clearMessages();
  }

  function updateBridgeToken(token: string) {
    setSimProxyConfig((prev) => ({ ...prev, token }));
    clearMessages();
  }


  async function copyNativeInstallCommand() {
    try {
      await navigator.clipboard.writeText(nativeInstallCommand);
      showNotice('安装命令已复制');
      setErrorMessage('');
    } catch {
      setErrorMessage(`请手动复制命令：${nativeInstallCommand}`);
    }
  }

  async function startNativeHostService() {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStart(simProxyConfig.token);
      setNativeState(payload.state);

      const latestBridgeConfig = await getSimProxyBridgeConfig();
      setSimProxyConfig(latestBridgeConfig);

      setErrorMessage('');
      showNotice(payload.state.running ? `本地服务运行中（PID: ${payload.state.pid ?? '-'}）` : '本地服务启动请求已发送');
      await refreshSimProxyStatus({ silent: true });
    } catch (error) {
      setErrorMessage(formatNativeHostActionError('start', error));
    } finally {
      setNativeBusy(false);
    }
  }

  async function stopNativeHostService() {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStop();
      setNativeState(payload.state);
      setErrorMessage('');
      showNotice('本地服务已停止');
      await refreshSimProxyStatus({ silent: true });
    } catch (error) {
      setErrorMessage(formatNativeHostActionError('stop', error));
    } finally {
      setNativeBusy(false);
    }
  }

  async function forceWakeupPolling() {
    try {
      setSimProxyBusy(true);
      const payload = await requestSimProxyWakeup();
      setSimProxyStatus(payload);
      setErrorMessage('');
      showNotice(`已手动唤起轮询：${getLevelLabel(payload.level)}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '手动唤起轮询失败');
    } finally {
      setSimProxyBusy(false);
    }
  }

  async function save() {
    try {
      const parsedHiddenDomains = parseHiddenDomainsInput(hiddenDomainsInput);
      await Promise.all([
        setPresetGroupStore(store),
        setPanelHiddenDomains(parsedHiddenDomains),
        setSimProxyBridgeConfig({ ...simProxyConfig, enabled: true }),
      ]);
      const [latestStore, latestHiddenDomains, latestBridgeConfig] = await Promise.all([
        getPresetGroupStore(),
        getPanelHiddenDomains(),
        getSimProxyBridgeConfig(),
      ]);
      setStore(clonePresetGroupStore(latestStore));
      setHiddenDomainsInput(formatHiddenDomainsInput(latestHiddenDomains));
      setSimProxyConfig(latestBridgeConfig);
      setErrorMessage('');
      showNotice('已保存');
      await refreshSimProxyStatus({ silent: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '保存失败');
    }
  }

  const statusLevelClassName = simProxyStatus ? getLevelClassName(simProxyStatus.level) : 'warn';

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

        <section className="bridge-card">
          <h2>本地接口代理</h2>
          <p className="hint">用于把目标站点（sim.3ue.co / sem.3ue.co）的登录态请求转发到本地服务供 Claude 调用。</p>

          <div className="native-steps">
            <div className="native-steps-title">使用步骤</div>
            <ol>
              <li>先点击“复制安装命令”，在终端执行一次安装（仅首次）。</li>
              <li>填写并保存 BRIDGE_TOKEN（建议使用强随机字符串）。</li>
              <li>点击“启动本地服务”，再点击“检查状态”确认运行中。</li>
              <li>浏览器打开并登录目标站点（SIM：https://sim.3ue.co；SEM：https://sem.3ue.co）。</li>
              <li>调用本地接口：/sim/api/websiteOrganicLandingPagesV2、/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown、/sim/api/KeywordGenerator/google/suggest、/sem/kmtgw/v2/webapi/ideas.GetKeywords、/sem/kmtgw/v2/webapi/ideas.GetKeywordsSummary 或 /sem/kwogw/v2/webapi/keywords.GetInfo。</li>
            </ol>
          </div>

          <div className="native-install-box">
            <div className="native-install-title">首次使用（只需一次）</div>
            <div className="native-install-command">{nativeInstallCommand}</div>
            <button type="button" onClick={() => void copyNativeInstallCommand()}>
              复制安装命令
            </button>
          </div>

          <div className="native-control-row">
            <button type="button" className="primary" disabled={nativeBusy} onClick={() => void startNativeHostService()}>
              启动本地服务
            </button>
            <button type="button" disabled={nativeBusy} onClick={() => void refreshNativeStatus({ showNotice: true })}>
              检查状态
            </button>
            <button type="button" className="danger" disabled={nativeBusy} onClick={() => void stopNativeHostService()}>
              停止服务
            </button>
          </div>

          <div className={`native-status ${nativeState?.running ? 'running' : 'stopped'}`}>
            本地服务状态：{formatNativeHostStatus(nativeState)}
          </div>

          <div className="bridge-status-head">
            <span className={`bridge-status-chip ${statusLevelClassName}`}>
              链路状态：{simProxyStatus ? getLevelLabel(simProxyStatus.level) : '未检查'}
            </span>
            <div className="native-control-row">
              <button type="button" disabled={simProxyBusy} onClick={() => void refreshSimProxyStatus({ showNotice: true })}>
                {simProxyBusy ? '检查中...' : '检查链路'}
              </button>
              <button type="button" className="primary" disabled={simProxyBusy} onClick={() => void forceWakeupPolling()}>
                强制唤起轮询
              </button>
            </div>
          </div>

          {simProxyStatus ? (
            <div className="bridge-status-panel">
              {renderStatusRow('摘要', simProxyStatus.summary)}
              {renderStatusRow('检查时间', formatStatusTime(simProxyStatus.checkedAt))}
              {renderStatusRow('Health', `${simProxyStatus.health.status}${simProxyStatus.health.ok ? '' : '（不可达）'}`)}
              {renderStatusRow(
                '队列',
                `pendingJobs=${formatStatusCount(simProxyStatus.health.pendingJobs)} / waitingResults=${formatStatusCount(simProxyStatus.health.waitingResults)} / waitingPollers=${formatStatusCount(simProxyStatus.health.waitingPollers)}`,
              )}
              {renderStatusRow(
                'Poll',
                `loop=${simProxyStatus.poll.loopRunning ? 'on' : 'off'} / lastOk=${formatStatusTime(simProxyStatus.poll.lastPollOkAt)}`,
              )}
              {renderStatusRow(
                'Dispatch',
                `pendingResult=${simProxyStatus.dispatch.pendingResultCount} / origin=${simProxyStatus.dispatch.lastOrigin || '-'}`,
              )}
              {renderStatusRow(
                '执行页 SIM',
                `tab=${simProxyStatus.dispatch.executor.sim.tabId ?? '-'} / heartbeat=${formatStatusTime(simProxyStatus.dispatch.executor.sim.lastHeartbeatAt)} / stale=${simProxyStatus.dispatch.executor.sim.stale ? 'yes' : 'no'}`,
              )}
              {renderStatusRow(
                '执行页 SEM',
                `tab=${simProxyStatus.dispatch.executor.sem.tabId ?? '-'} / heartbeat=${formatStatusTime(simProxyStatus.dispatch.executor.sem.lastHeartbeatAt)} / stale=${simProxyStatus.dispatch.executor.sem.stale ? 'yes' : 'no'}`,
              )}
              {renderStatusRow(
                'Failover',
                `count=${simProxyStatus.dispatch.executor.failoverCount} / last=${formatStatusTime(simProxyStatus.dispatch.executor.lastFailoverAt)}`,
              )}
              {simProxyStatus.dispatch.executor.lastFailoverReason
                ? renderStatusRow('Failover 原因', simProxyStatus.dispatch.executor.lastFailoverReason)
                : null}
              {renderStatusRow(
                'Result',
                `received=${formatStatusTime(simProxyStatus.result.lastResultReceivedAt)} / posted=${formatStatusTime(simProxyStatus.result.lastResultPostedAt)}`,
              )}
              {simProxyStatus.health.lastError ? renderStatusRow('Health 错误', simProxyStatus.health.lastError) : null}
              {simProxyStatus.poll.lastPollError ? renderStatusRow('Poll 错误', simProxyStatus.poll.lastPollError) : null}
              {simProxyStatus.dispatch.lastDispatchError
                ? renderStatusRow('Dispatch 错误', simProxyStatus.dispatch.lastDispatchError)
                : null}
              {simProxyStatus.result.lastResultPostError
                ? renderStatusRow('Result 错误', simProxyStatus.result.lastResultPostError)
                : null}
            </div>
          ) : (
            <div className="bridge-status-empty">尚未获取链路状态，点击“检查链路”。</div>
          )}

          <p className="hint">本地服务启动后将自动连接代理链路，无需手动开关。</p>

          <div className="bridge-status-row">
            <label className="bridge-status-label">自动维护执行页</label>
            <input
              type="checkbox"
              checked={simProxyConfig.autoMaintainExecutors}
              onChange={(event) => updateAutoMaintainExecutors(event.target.checked)}
            />
          </div>
          <div className="bridge-status-row">
            <label className="bridge-status-label">固定（Pin）执行页</label>
            <input
              type="checkbox"
              checked={simProxyConfig.pinExecutorTabs}
              onChange={(event) => updatePinExecutorTabs(event.target.checked)}
            />
          </div>
          <div className="bridge-inputs">
            <input
              value={simProxyConfig.baseUrl}
              onChange={(event) => updateBridgeBaseUrl(event.target.value)}
              placeholder="本地服务地址，例如 http://127.0.0.1:17311"
            />
            <input
              value={simProxyConfig.token}
              onChange={(event) => updateBridgeToken(event.target.value)}
              placeholder="BRIDGE_TOKEN（与本地服务一致）"
            />
          </div>


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
