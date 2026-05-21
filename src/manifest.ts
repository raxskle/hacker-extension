import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Hacker Extension',
  version: '0.0.1',
  description: '外链管理神器，快速填充预设文本和外链信息。',
  action: {
    default_title: 'Hacker Extension',
  },
  permissions: ['storage', 'unlimitedStorage'],
  host_permissions: ['<all_urls>', 'https://api.notion.com/*'],
  options_page: 'options.html',
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/main.tsx'],
      run_at: 'document_idle',
    },
  ],
});
