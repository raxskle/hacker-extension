#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.hacker_extension.bridge';
const HOST_DESCRIPTION = 'Hacker Extension Native Bridge Host';

function parseExtensionId(argv) {
  const fromArg = argv
    .map((item) => item.trim())
    .find((item) => item.startsWith('--extension-id='))
    ?.slice('--extension-id='.length)
    .trim();

  const value = fromArg || process.env.EXTENSION_ID || '';
  return value;
}

function validateExtensionId(value) {
  return /^[a-p]{32}$/.test(value);
}

function ensureExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // ignore chmod failure on unsupported fs
  }
}

function main() {
  const extensionId = parseExtensionId(process.argv.slice(2));
  if (!validateExtensionId(extensionId)) {
    console.error('安装失败：请传入有效的扩展 ID（32 位 a-p 字符）。');
    console.error('示例：npm run native:install:mac -- --extension-id=abcdefghijklmnopabcdefghijklmnop');
    process.exit(1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const hostPath = path.resolve(scriptDir, 'host.mjs');
  const launcherPath = path.resolve(scriptDir, 'host-launcher.sh');

  if (!fs.existsSync(hostPath)) {
    console.error(`安装失败：未找到 host 脚本 ${hostPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(launcherPath)) {
    console.error(`安装失败：未找到 host 启动脚本 ${launcherPath}`);
    process.exit(1);
  }

  ensureExecutable(hostPath);
  ensureExecutable(launcherPath);

  const targetDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts',
  );
  fs.mkdirSync(targetDir, { recursive: true });

  const manifestPath = path.join(targetDir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('Native host 安装完成。');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Launcher: ${launcherPath}`);
  console.log(`Host: ${hostPath}`);
  console.log(`Allowed extension: chrome-extension://${extensionId}/`);
}

main();
