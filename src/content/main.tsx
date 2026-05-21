import { createRoot, type Root } from 'react-dom/client';
import { extractHostname } from '../shared/notion';
import { getPanelEnabled, getPanelHiddenDomains } from '../shared/storage';
import { STORAGE_KEYS } from '../shared/types';
import App from './App';
import './content.css';

const ROOT_ID = '__quick_preset_filler_root__';

let rootElement: HTMLDivElement | null = null;
let reactRoot: Root | null = null;

function mount() {
  if (reactRoot && rootElement?.isConnected) {
    return;
  }

  const existingRoot = document.getElementById(ROOT_ID);
  if (existingRoot instanceof HTMLDivElement) {
    rootElement = existingRoot;
  } else {
    rootElement = document.createElement('div');
    rootElement.id = ROOT_ID;
    document.documentElement.appendChild(rootElement);
  }

  reactRoot = createRoot(rootElement);
  reactRoot.render(<App rootElement={rootElement} />);
}

function unmount() {
  reactRoot?.unmount();
  reactRoot = null;

  if (rootElement?.isConnected) {
    rootElement.remove();
  }

  rootElement = null;
}

function syncMountedState(shouldMount: boolean) {
  if (shouldMount) {
    mount();
    return;
  }

  unmount();
}

function isBlockedDomain(hostname: string, blockedDomains: string[]): boolean {
  return blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function shouldMountOnCurrentPage(panelEnabled: boolean, blockedDomains: string[]): boolean {
  if (!panelEnabled) {
    return false;
  }

  const currentHostname = extractHostname(window.location.href);
  if (!currentHostname) {
    return true;
  }

  return !isBlockedDomain(currentHostname, blockedDomains);
}

async function syncMountedStateFromStorage() {
  const [panelEnabled, blockedDomains] = await Promise.all([getPanelEnabled(), getPanelHiddenDomains()]);
  syncMountedState(shouldMountOnCurrentPage(panelEnabled, blockedDomains));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!changes[STORAGE_KEYS.panelEnabled] && !changes[STORAGE_KEYS.panelHiddenDomains]) {
    return;
  }

  void syncMountedStateFromStorage();
});

void syncMountedStateFromStorage();
