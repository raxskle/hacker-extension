import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Hacker Extension',
  version: '0.1.0',
  description: '出海助手 - 找词、找站、数据、外链一站式解决方案',
  action: {
    default_title: 'Hacker Extension',
    default_popup: 'popup.html',
  },
  permissions: ['storage', 'unlimitedStorage', 'downloads', 'nativeMessaging', 'alarms', 'scripting'],
  host_permissions: [
    '<all_urls>',
    'https://api.notion.com/*',
    'https://sim.3ue.co/*',
    'https://sem.3ue.co/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
  options_page: 'options.html',
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/recorderBridge.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
    {
      matches: ['<all_urls>'],
      js: ['src/content/recorderInjected.ts'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
    {
      matches: ['https://sim.3ue.co/*', 'https://sem.3ue.co/*'],
      js: ['src/content/simProxyBridge.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
    {
      matches: ['https://sim.3ue.co/*', 'https://sem.3ue.co/*'],
      js: ['src/content/simProxyInjected.ts'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
    {
      matches: ['<all_urls>'],
      js: ['src/content/main.tsx'],
      run_at: 'document_idle',
    },
  ],
});
