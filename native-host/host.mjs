#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.hacker_extension.bridge';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_PATH = path.join(ROOT_DIR, 'local-service', 'server.mjs');
const STATE_DIR = path.join(os.homedir(), '.hacker-extension-native');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');
const DEFAULT_PORT = 17311;
const START_VERIFY_TIMEOUT_MS = 1200;
const STOP_VERIFY_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 120;

function createHostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureServicePath() {
  if (!fs.existsSync(SERVICE_PATH)) {
    throw createHostError('SERVICE_PATH_MISSING', `未找到本地服务脚本：${SERVICE_PATH}`);
  }
}

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (error) {
    throw createHostError(
      'PERMISSION_OR_PATH',
      `状态目录不可写：${STATE_DIR}。请检查权限。${error instanceof Error ? ` ${error.message}` : ''}`,
    );
  }
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
    };
  } catch {
    return { pid: null, token: '', startedAt: null };
  }
}

function writeState(next) {
  ensureStateDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    throw createHostError(
      'PERMISSION_OR_PATH',
      `状态文件写入失败：${STATE_FILE}。请检查权限。${error instanceof Error ? ` ${error.message}` : ''}`,
    );
  }
}

function clearState() {
  const current = readState();
  writeState({ pid: null, token: current.token, startedAt: null });
}

function isPidRunning(pid) {
  if (typeof pid !== 'number' || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function generateToken() {
  return randomBytes(24).toString('hex');
}

function readExactly(fd, totalBytes) {
  const buffer = Buffer.alloc(totalBytes);
  let offset = 0;

  while (offset < totalBytes) {
    const bytesRead = fs.readSync(fd, buffer, offset, totalBytes - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  if (offset !== totalBytes) {
    return null;
  }

  return buffer;
}

function readMessage() {
  const header = readExactly(0, 4);
  if (!header) {
    return null;
  }

  const length = header.readUInt32LE(0);
  if (!Number.isFinite(length) || length <= 0 || length > 10 * 1024 * 1024) {
    throw createHostError('INVALID_REQUEST', 'Native message length invalid');
  }

  const payloadBuffer = readExactly(0, length);
  if (!payloadBuffer) {
    return null;
  }

  try {
    return JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    throw createHostError('INVALID_REQUEST', 'Native message JSON 解析失败');
  }
}

function sendMessage(message) {
  const data = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([header, data]));
}

function buildBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function normalizeStaleState({ repair } = { repair: false }) {
  const current = readState();
  const isStalePid = current.pid !== null && !isPidRunning(current.pid);
  if (!isStalePid) {
    return current;
  }

  const next = {
    pid: null,
    token: current.token,
    startedAt: null,
  };

  if (repair) {
    writeState(next);
  }

  return next;
}

function buildStateResponse(override = {}, port = DEFAULT_PORT) {
  const current = readState();
  const pid = typeof override.pid === 'number' || override.pid === null ? override.pid : current.pid;
  const token = typeof override.token === 'string' ? override.token : current.token;
  const startedAt = typeof override.startedAt === 'number' || override.startedAt === null ? override.startedAt : current.startedAt;

  return {
    running: isPidRunning(pid),
    pid,
    baseUrl: buildBaseUrl(port),
    token,
    startedAt,
    hostName: HOST_NAME,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return check();
}

function stopRunningServicePid(pid) {
  if (!isPidRunning(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    throw createHostError('STOP_FAILED', `结束本地服务进程失败（PID: ${pid}）。${error instanceof Error ? error.message : ''}`);
  }
}

async function startService(inputToken, inputPort) {
  ensureServicePath();

  const port = typeof inputPort === 'number' && Number.isFinite(inputPort) && inputPort > 0 ? Math.round(inputPort) : DEFAULT_PORT;
  const current = normalizeStaleState({ repair: true });
  const requestedToken = typeof inputToken === 'string' && inputToken.trim() ? inputToken.trim() : '';
  const token = requestedToken || current.token || generateToken();

  if (isPidRunning(current.pid)) {
    if (current.token === token) {
      return buildStateResponse(current, port);
    }

    stopRunningServicePid(current.pid);
    const stopped = await waitForCondition(() => !isPidRunning(current.pid), STOP_VERIFY_TIMEOUT_MS);
    if (!stopped) {
      throw createHostError('STOP_FAILED', `旧服务停止超时（PID: ${current.pid}）。请稍后重试。`);
    }
  }

  ensureStateDir();

  let outFd;
  try {
    outFd = fs.openSync(LOG_FILE, 'a');
  } catch (error) {
    throw createHostError('PERMISSION_OR_PATH', `日志文件不可写：${LOG_FILE}。${error instanceof Error ? error.message : ''}`);
  }

  let child;
  try {
    child = spawn(process.execPath, [SERVICE_PATH], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(port),
        BRIDGE_TOKEN: token,
      },
    });
  } catch (error) {
    fs.closeSync(outFd);
    throw createHostError('SERVICE_SPAWN_FAILED', `本地服务拉起失败。${error instanceof Error ? error.message : ''}`);
  }

  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  child.unref();
  fs.closeSync(outFd);

  if (spawnError) {
    throw createHostError('SERVICE_SPAWN_FAILED', `本地服务拉起失败。${spawnError instanceof Error ? spawnError.message : ''}`);
  }

  const nextState = {
    pid: child.pid ?? null,
    token,
    startedAt: Date.now(),
  };

  writeState(nextState);

  const started = await waitForCondition(() => isPidRunning(nextState.pid), START_VERIFY_TIMEOUT_MS);
  if (!started) {
    clearState();
    throw createHostError('SERVICE_STARTUP_FAILED', `本地服务未成功启动。请检查端口占用或日志：${LOG_FILE}`);
  }

  return buildStateResponse(nextState, port);
}

async function stopService(inputPort) {
  const port = typeof inputPort === 'number' && Number.isFinite(inputPort) && inputPort > 0 ? Math.round(inputPort) : DEFAULT_PORT;
  const current = normalizeStaleState({ repair: true });
  if (isPidRunning(current.pid)) {
    stopRunningServicePid(current.pid);

    const stopped = await waitForCondition(() => !isPidRunning(current.pid), STOP_VERIFY_TIMEOUT_MS);
    if (!stopped) {
      throw createHostError('STOP_FAILED', `停止超时，服务仍在运行（PID: ${current.pid}）。请手动结束进程。`);
    }
  }

  clearState();
  return buildStateResponse({ pid: null, startedAt: null, token: current.token }, port);
}

function statusService(inputPort) {
  const port = typeof inputPort === 'number' && Number.isFinite(inputPort) && inputPort > 0 ? Math.round(inputPort) : DEFAULT_PORT;
  try {
    const state = normalizeStaleState({ repair: true });
    return buildStateResponse(state, port);
  } catch (error) {
    throw createHostError('STATUS_UNAVAILABLE', `读取本地服务状态失败。${error instanceof Error ? error.message : ''}`);
  }
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function normalizeError(error) {
  if (typeof error === 'object' && error !== null) {
    const maybeCode = error.code;
    const maybeMessage = error.message;
    if (typeof maybeCode === 'string' && typeof maybeMessage === 'string' && maybeMessage) {
      return {
        code: maybeCode,
        message: maybeMessage,
      };
    }
  }

  return {
    code: 'HOST_ERROR',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error : '宿主执行失败',
  };
}

async function main() {
  try {
    const request = readMessage();
    if (!request || typeof request !== 'object') {
      sendMessage(fail('INVALID_REQUEST', '无效请求'));
      return;
    }

    const command = request.command;
    const port = typeof request.port === 'number' ? request.port : DEFAULT_PORT;

    if (command === 'status') {
      sendMessage(ok(statusService(port)));
      return;
    }

    if (command === 'start') {
      const token = typeof request.token === 'string' ? request.token : '';
      sendMessage(ok(await startService(token, port)));
      return;
    }

    if (command === 'stop') {
      sendMessage(ok(await stopService(port)));
      return;
    }

    sendMessage(fail('UNSUPPORTED_COMMAND', `不支持 command: ${String(command)}`));
  } catch (error) {
    const normalized = normalizeError(error);
    sendMessage(fail(normalized.code, normalized.message));
  }
}

void main();
