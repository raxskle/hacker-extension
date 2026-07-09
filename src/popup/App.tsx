import { useEffect, useMemo, useState } from 'react';
import { requestNativeHostStart, requestNativeHostStatus, requestNativeHostStop, type NativeHostState } from '../shared/nativeHost';
import { requestSimProxyStatus, type SimProxyBridgeStatusPayload, type SimProxyStatusLevel } from '../shared/simProxy';
import { getPanelEnabled, setPanelEnabled } from '../shared/storage';

function formatNativeHostStatus(state: NativeHostState | null): string {
  if (!state) {
    return '未检查';
  }

  return state.running ? `运行中（PID: ${state.pid ?? '-'})` : '未运行';
}

function getStatusLabel(level: SimProxyStatusLevel): string {
  if (level === 'warn') {
    return '告警';
  }

  if (level === 'error') {
    return '异常';
  }

  return '正常';
}

function getStatusClassName(level: SimProxyStatusLevel): 'running' | 'warn' | 'stopped' {
  if (level === 'warn') {
    return 'warn';
  }

  if (level === 'error') {
    return 'stopped';
  }

  return 'running';
}

export default function App() {
  const [panelEnabled, setPanelEnabledState] = useState<boolean>(true);
  const [panelBusy, setPanelBusy] = useState(false);
  const [nativeState, setNativeState] = useState<NativeHostState | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [simProxyStatus, setSimProxyStatus] = useState<SimProxyBridgeStatusPayload | null>(null);
  const [simProxyBusy, setSimProxyBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const statusClassName = useMemo(() => {
    if (!simProxyStatus) {
      return 'warn';
    }

    return getStatusClassName(simProxyStatus.level);
  }, [simProxyStatus]);

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(''), 1200);
  }

  useEffect(() => {
    void (async () => {
      try {
        const enabled = await getPanelEnabled();
        setPanelEnabledState(enabled);
      } catch {
        // keep default value
      }

      await Promise.all([refreshNativeStatus(), refreshSimProxyStatus()]);
    })();
  }, []);

  async function togglePanel() {
    try {
      setPanelBusy(true);
      const nextEnabled = !panelEnabled;
      await setPanelEnabled(nextEnabled);
      setPanelEnabledState(nextEnabled);
      setErrorMessage('');
      showNotice(nextEnabled ? '浮窗已开启' : '浮窗已隐藏');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '切换浮窗失败');
    } finally {
      setPanelBusy(false);
    }
  }

  async function refreshNativeStatus(options?: { showNotice?: boolean }) {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStatus();
      setNativeState(payload.state);
      setErrorMessage('');
      if (options?.showNotice) {
        showNotice(payload.state.running ? '本地服务运行中' : '本地服务未运行');
      }
    } catch (error) {
      setNativeState(null);
      setErrorMessage(error instanceof Error ? error.message : '本地宿主未安装或不可用');
    } finally {
      setNativeBusy(false);
    }
  }

  async function refreshSimProxyStatus(options?: { showNotice?: boolean }) {
    try {
      setSimProxyBusy(true);
      const payload = await requestSimProxyStatus();
      setSimProxyStatus(payload);
      setErrorMessage('');
      if (options?.showNotice) {
        showNotice(`链路状态：${getStatusLabel(payload.level)}`);
      }
    } catch (error) {
      setSimProxyStatus(null);
      setErrorMessage(error instanceof Error ? error.message : '链路状态检查失败');
    } finally {
      setSimProxyBusy(false);
    }
  }

  async function startNativeService() {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStart();
      setNativeState(payload.state);
      setErrorMessage('');
      showNotice(payload.state.running ? `本地服务运行中（PID: ${payload.state.pid ?? '-'})` : '本地服务启动请求已发送');
      await refreshSimProxyStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '启动本地服务失败');
    } finally {
      setNativeBusy(false);
    }
  }

  async function stopNativeService() {
    try {
      setNativeBusy(true);
      const payload = await requestNativeHostStop();
      setNativeState(payload.state);
      setErrorMessage('');
      showNotice('本地服务已停止');
      await refreshSimProxyStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '停止本地服务失败');
    } finally {
      setNativeBusy(false);
    }
  }

  return (
    <main className="popup-root">
      <section className="popup-card">
        <h1>快捷控制</h1>

        {errorMessage ? <div className="error-message">{errorMessage}</div> : null}

        <section className="popup-section">
          <div className="section-head">
            <h2>浮窗面板</h2>
            <span className={`status-chip ${panelEnabled ? 'running' : 'stopped'}`}>{panelEnabled ? '已开启' : '已关闭'}</span>
          </div>
          <button type="button" className="primary" disabled={panelBusy} onClick={() => void togglePanel()}>
            {panelEnabled ? '隐藏浮窗' : '显示浮窗'}
          </button>
        </section>

        <section className="popup-section">
          <div className="section-head">
            <h2>本地服务</h2>
            <span className={`status-chip ${nativeState?.running ? 'running' : 'stopped'}`}>
              {nativeState?.running ? '运行中' : '未运行'}
            </span>
          </div>
          <div className="native-status">{formatNativeHostStatus(nativeState)}</div>
          <div className="action-row">
            <button type="button" className="primary" disabled={nativeBusy} onClick={() => void startNativeService()}>
              启动
            </button>
            <button type="button" disabled={nativeBusy} onClick={() => void refreshNativeStatus({ showNotice: true })}>
              检查状态
            </button>
            <button type="button" className="danger" disabled={nativeBusy} onClick={() => void stopNativeService()}>
              停止
            </button>
          </div>
        </section>

        <section className="popup-section">
          <div className="section-head">
            <h2>转发链路</h2>
            <span className={`status-chip ${statusClassName}`}>
              {simProxyStatus ? getStatusLabel(simProxyStatus.level) : '未检查'}
            </span>
          </div>
          <div className="native-status">{simProxyStatus?.summary || '点击检查链路获取当前状态'}</div>
          <div className="native-status subtle">
            {simProxyStatus
              ? `队列 pending=${simProxyStatus.health.pendingJobs ?? '-'} / waiting=${simProxyStatus.health.waitingResults ?? '-'}`
              : '-'}
          </div>
          <div className="action-row">
            <button type="button" disabled={simProxyBusy} onClick={() => void refreshSimProxyStatus({ showNotice: true })}>
              {simProxyBusy ? '检查中...' : '检查链路'}
            </button>
          </div>
        </section>

        <div className="notice">{notice}</div>
      </section>
    </main>
  );
}
