import http from 'node:http';
import { randomUUID } from 'node:crypto';

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.BRIDGE_PORT || '17311', 10);
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_SIM_TIMEOUT_MS = 45_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_SIM_TIMEOUT_MS = 180_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const MAX_POLL_WAIT_MS = 25_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SIM_TARGET_ORIGIN = 'https://sim.3ue.co';
const DEFAULT_TARGET_ORIGIN = SIM_TARGET_ORIGIN;
const ALLOWED_TARGET_ORIGINS = new Set([SIM_TARGET_ORIGIN, 'https://sem.3ue.co']);

const TARGET_ENDPOINT_PATH = '/api/websiteOrganicLandingPagesV2';
const TARGET_DRILLDOWN_ENDPOINT_PATH = '/api/websiteOrganicLandingPagesV2/GetTableDrillDown';

const SIM_TARGET_PUBLIC_ENDPOINT = `/sim${TARGET_ENDPOINT_PATH}`;
const SIM_TARGET_DRILLDOWN_PUBLIC_ENDPOINT = `/sim${TARGET_DRILLDOWN_ENDPOINT_PATH}`;

const EXPOSED_TARGET_ENDPOINTS = [SIM_TARGET_PUBLIC_ENDPOINT, SIM_TARGET_DRILLDOWN_PUBLIC_ENDPOINT];

/** @type {Array<{id: string, method: string, path: string, headers: Record<string,string>, body: string, timeoutMs: number, origin: string}>} */
const jobQueue = [];

/** @type {Map<string, {resolve: (value: any) => void, reject: (error: Error) => void, timeoutId: NodeJS.Timeout}>} */
const pendingResults = new Map();

/** @type {Array<{send: (job: any) => void, timeoutId: NodeJS.Timeout}>} */
const pollWaiters = [];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

function parseAuthorizationToken(req) {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') {
    return '';
  }

  const [scheme, token] = raw.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return '';
  }

  return token.trim();
}

function isAuthorized(req) {
  if (!BRIDGE_TOKEN) {
    return false;
  }

  return parseAuthorizationToken(req) === BRIDGE_TOKEN;
}

function isExtensionCaller(req) {
  const extensionId = req.headers['x-extension-id'];
  return typeof extensionId === 'string' && extensionId.trim().length > 0;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });

    req.on('error', reject);
  });
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeHeaders(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [String(key).trim(), typeof value === 'string' ? value : String(value)])
      .filter(([key]) => key.length > 0),
  );
}

function normalizePath(inputPath, inputUrl) {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : typeof inputUrl === 'string' ? inputUrl.trim() : '';
  if (!raw) {
    throw new Error('path 不能为空');
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const parsed = new URL(raw);
    if (!ALLOWED_TARGET_ORIGINS.has(parsed.origin)) {
      throw new Error('仅允许已配置的目标站点域名');
    }

    return `${parsed.pathname}${parsed.search}`;
  }

  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }

  return fallback;
}

function normalizeNonEmptyString(value, fallback) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return fallback;
}

function normalizeDateBucket(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (/^\d{4}\|\d{2}\|\d{2}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function enqueueJob(job) {
  const waiter = pollWaiters.shift();
  if (waiter) {
    clearTimeout(waiter.timeoutId);
    waiter.send(job);
    return;
  }

  jobQueue.push(job);
}

function dequeueJob() {
  if (jobQueue.length === 0) {
    return null;
  }

  return jobQueue.shift() ?? null;
}

function createPendingResultPromise(requestId, waitTimeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingResults.delete(requestId);
      reject(new Error('等待扩展响应超时'));
    }, waitTimeoutMs);

    pendingResults.set(requestId, { resolve, reject, timeoutId });
  });
}

async function submitBridgeJobAndWait(job, waitTimeoutMs) {
  const resultPromise = createPendingResultPromise(job.id, waitTimeoutMs);
  enqueueJob(job);
  return resultPromise;
}

async function respondBridgeResult(res, requestId, job, waitTimeoutMs) {
  try {
    const result = await submitBridgeJobAndWait(job, waitTimeoutMs);

    if (result?.ok === true && result.payload) {
      sendJson(res, 200, {
        ok: true,
        data: {
          status: result.payload.status,
          headers: result.payload.headers,
          body: result.payload.body,
          truncated: result.payload.truncated,
          finalUrl: result.payload.finalUrl,
        },
        meta: { requestId },
      });
      return;
    }

    sendJson(res, 502, {
      ok: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: typeof result?.error === 'string' ? result.error : '页面执行失败',
      },
      meta: { requestId },
    });
  } catch (error) {
    sendJson(res, 504, {
      ok: false,
      error: { code: 'TIMEOUT', message: error instanceof Error ? error.message : '请求超时' },
      meta: { requestId },
    });
  }
}

function createLandingPagesPath(paramsInput) {
  const key = normalizeNonEmptyString(paramsInput?.key, '');
  if (!key) {
    throw new Error('key 必填，例如 vercel.app');
  }

  const country = normalizeNonEmptyString(paramsInput?.country, '999');
  const latest = normalizeNonEmptyString(paramsInput?.latest, '28d');
  const webSource = normalizeNonEmptyString(paramsInput?.webSource, 'Total');
  const sourceType = normalizeNonEmptyString(paramsInput?.sourceType, 'organic');
  const sort = normalizeNonEmptyString(paramsInput?.sort, 'ClicksShare');
  const searchType = normalizeNonEmptyString(paramsInput?.searchType, 'domain');
  const asc = normalizeBoolean(paramsInput?.asc, false);
  const includeSubDomains = normalizeBoolean(paramsInput?.includeSubDomains, true);
  const isWindow = normalizeBoolean(paramsInput?.isWindow, true);
  const page = clamp(paramsInput?.page, 1, 500, 1);

  const from = normalizeDateBucket(paramsInput?.from);
  const to = normalizeDateBucket(paramsInput?.to);

  const pageFilterJson = JSON.stringify([{ url: key, searchType }]);
  const orderBy = `${sort} ${asc ? 'asc' : 'desc'}`;

  const query = new URLSearchParams();
  query.set('country', country);
  if (to) {
    query.set('to', to);
  }
  if (from) {
    query.set('from', from);
  }
  query.set('isWindow', String(isWindow));
  query.set('webSource', webSource);
  query.set('key', key);
  query.set('pageFilterJson', pageFilterJson);
  query.set('sort', sort);
  query.set('asc', String(asc));
  query.set('sourceType', sourceType);
  query.set('includeSubDomains', String(includeSubDomains));
  query.set('orderBy', orderBy);
  query.set('page', String(page));
  query.set('latest', latest);

  const xSwPage =
    'https://pro.similarweb.com/#/organicsearch/pageAnalysis/landing-pages-v2/*/' +
    `${country}/${latest}?key=${encodeURIComponent(key)}&pageFilter=${encodeURIComponent(pageFilterJson)}` +
    `&webSource=${encodeURIComponent(webSource)}&selectedPageTab=Organic`;

  return {
    path: `${TARGET_ENDPOINT_PATH}?${query.toString()}`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'x-requested-with': 'XMLHttpRequest',
      'x-sw-page': xSwPage,
      'x-sw-page-view-id': randomUUID(),
    },
  };
}

function createLandingPagesKeywordDrillDownPath(paramsInput) {
  const key = normalizeNonEmptyString(paramsInput?.key, '');
  if (!key) {
    throw new Error('key 必填，例如 vercel.app');
  }

  const landingPage = normalizeNonEmptyString(paramsInput?.landingPage, '');
  if (!landingPage) {
    throw new Error('landingPage 必填，例如 bacstory.vercel.app/bac-2026');
  }

  const country = normalizeNonEmptyString(paramsInput?.country, '999');
  const latest = normalizeNonEmptyString(paramsInput?.latest, '28d');
  const webSource = normalizeNonEmptyString(paramsInput?.webSource, 'Total');
  const sourceType = normalizeNonEmptyString(paramsInput?.sourceType, 'organic');
  const sort = normalizeNonEmptyString(paramsInput?.sort, 'ClicksShare');
  const searchType = normalizeNonEmptyString(paramsInput?.searchType, 'domain');
  const change = normalizeNonEmptyString(paramsInput?.change, 'New');
  const asc = normalizeBoolean(paramsInput?.asc, false);
  const includeSubDomains = normalizeBoolean(paramsInput?.includeSubDomains, true);
  const isWindow = normalizeBoolean(paramsInput?.isWindow, true);
  const rowsPerPage = clamp(paramsInput?.rowsPerPage, 1, 500, 50);

  const from = normalizeDateBucket(paramsInput?.from);
  const to = normalizeDateBucket(paramsInput?.to);

  const pageFilterJson = JSON.stringify([{ url: key, searchType }]);

  const query = new URLSearchParams();
  query.set('country', country);
  query.set('webSource', webSource);
  query.set('includeSubDomains', String(includeSubDomains));
  if (to) {
    query.set('to', to);
  }
  if (from) {
    query.set('from', from);
  }
  query.set('isWindow', String(isWindow));
  query.set('landingPage', landingPage);
  query.set('rowsPerPage', String(rowsPerPage));
  query.set('key', key);
  query.set('sort', sort);
  query.set('asc', String(asc));
  query.set('sourceType', sourceType);
  query.set('latest', latest);

  const xSwPage =
    'https://pro.similarweb.com/#/organicsearch/pageAnalysis/landing-pages-v2/*/' +
    `${country}/${latest}?key=${encodeURIComponent(key)}&pageFilter=${encodeURIComponent(pageFilterJson)}` +
    `&webSource=${encodeURIComponent(webSource)}&Change=${encodeURIComponent(change)}&selectedPageTab=Organic`;

  return {
    path: `${TARGET_DRILLDOWN_ENDPOINT_PATH}?${query.toString()}`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'x-requested-with': 'XMLHttpRequest',
      'x-sw-page': xSwPage,
      'x-sw-page-view-id': randomUUID(),
    },
  };
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    ok: true,
    data: {
      status: 'up',
      pendingJobs: jobQueue.length,
      waitingResults: pendingResults.size,
      waitingPollers: pollWaiters.length,
      exposedEndpoint: SIM_TARGET_PUBLIC_ENDPOINT,
      exposedEndpoints: EXPOSED_TARGET_ENDPOINTS,
      targetPath: TARGET_ENDPOINT_PATH,
    },
  });
}

async function handleSimRequest(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: { code: 'AUTH_FAILED', message: 'token 无效' } });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求格式错误' },
    });
    return;
  }

  const methodRaw = typeof body?.request?.method === 'string' ? body.request.method.trim().toUpperCase() : 'GET';
  if (!ALLOWED_METHODS.has(methodRaw)) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_METHOD', message: `不支持 method: ${methodRaw}` } });
    return;
  }

  let path;
  try {
    path = normalizePath(body?.request?.path, body?.request?.url);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_PATH', message: error instanceof Error ? error.message : 'path 无效' },
    });
    return;
  }

  const requestId = typeof body?.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : randomUUID();

  sendJson(res, 410, {
    ok: false,
    error: {
      code: 'ENDPOINT_RETIRED',
      message: `/v1/sim/request 已下线。请使用专用接口 ${SIM_TARGET_PUBLIC_ENDPOINT}`,
    },
    meta: { requestId, rejectedPath: path },
  });
}

async function handleBridgeQueryRequest(req, res, options = {}) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: { code: 'AUTH_FAILED', message: 'token 无效' } });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求格式错误' },
    });
    return;
  }

  const buildQuery = typeof options?.buildQuery === 'function' ? options.buildQuery : createLandingPagesPath;
  const method = typeof options?.method === 'string' ? options.method.trim().toUpperCase() : 'POST';
  if (!ALLOWED_METHODS.has(method)) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_METHOD', message: `不支持 method: ${method}` },
    });
    return;
  }

  let queryConfig;
  try {
    queryConfig = buildQuery(body);
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'INVALID_PARAMS', message: error instanceof Error ? error.message : '参数无效' },
    });
    return;
  }

  const requestId = typeof body?.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : randomUUID();
  const timeoutMs = clamp(body?.timeoutMs, 1_000, MAX_SIM_TIMEOUT_MS, DEFAULT_SIM_TIMEOUT_MS);
  const waitTimeoutMs = clamp(body?.waitTimeoutMs, 1_000, MAX_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS);

  const requestedOriginFromOptions = typeof options?.origin === 'string' ? options.origin.trim() : '';
  const requestedOriginFromBody = typeof body?.origin === 'string' ? body.origin.trim() : '';
  const requestedOrigin = requestedOriginFromOptions || requestedOriginFromBody;
  const origin = ALLOWED_TARGET_ORIGINS.has(requestedOrigin) ? requestedOrigin : DEFAULT_TARGET_ORIGIN;

  const job = {
    id: requestId,
    method,
    path: queryConfig.path,
    headers: normalizeHeaders(queryConfig.headers),
    body: method === 'GET' ? '' : typeof body?.requestBody === 'string' ? body.requestBody : '',
    timeoutMs,
    origin,
  };

  await respondBridgeResult(res, requestId, job, waitTimeoutMs);
}

async function handleLandingPagesRequest(req, res, options = {}) {
  await handleBridgeQueryRequest(req, res, {
    ...options,
    method: 'POST',
    buildQuery: createLandingPagesPath,
  });
}

async function handleLandingPagesKeywordDrillDownRequest(req, res, options = {}) {
  await handleBridgeQueryRequest(req, res, {
    ...options,
    method: 'GET',
    buildQuery: createLandingPagesKeywordDrillDownPath,
  });
}

async function handleExtensionPoll(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (!isExtensionCaller(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid-json' });
    return;
  }

  const existing = dequeueJob();
  if (existing) {
    sendJson(res, 200, existing);
    return;
  }

  const waitMs = clamp(body?.maxWaitMs, 1_000, MAX_POLL_WAIT_MS, MAX_POLL_WAIT_MS);
  const timeoutId = setTimeout(() => {
    const index = pollWaiters.findIndex((item) => item.timeoutId === timeoutId);
    if (index >= 0) {
      pollWaiters.splice(index, 1);
    }
    sendNoContent(res);
  }, waitMs);

  pollWaiters.push({
    timeoutId,
    send: (job) => {
      sendJson(res, 200, job);
    },
  });
}

async function handleExtensionResult(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (!isExtensionCaller(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid-json' });
    return;
  }

  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) {
    sendJson(res, 400, { ok: false, error: 'missing-id' });
    return;
  }

  const pending = pendingResults.get(id);
  if (!pending) {
    sendJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingResults.delete(id);

  if (body?.ok === true && body?.payload && typeof body.payload === 'object') {
    pending.resolve({ ok: true, payload: body.payload });
  } else {
    pending.resolve({ ok: false, error: typeof body?.error === 'string' ? body.error : 'unknown-error' });
  }

  sendJson(res, 200, { ok: true, accepted: true });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (method === 'GET' && url.pathname === '/health') {
    handleHealth(req, res);
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/sim/request') {
    await handleSimRequest(req, res);
    return;
  }

  if (method === 'POST' && url.pathname === SIM_TARGET_PUBLIC_ENDPOINT) {
    await handleLandingPagesRequest(req, res, { origin: SIM_TARGET_ORIGIN });
    return;
  }

  if (method === 'POST' && url.pathname === SIM_TARGET_DRILLDOWN_PUBLIC_ENDPOINT) {
    await handleLandingPagesKeywordDrillDownRequest(req, res, { origin: SIM_TARGET_ORIGIN });
    return;
  }


  if (method === 'POST' && url.pathname === '/v1/extension/poll') {
    await handleExtensionPoll(req, res);
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/extension/result') {
    await handleExtensionResult(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
});

server.listen(PORT, HOST, () => {
  if (!BRIDGE_TOKEN) {
    console.warn('[sim-bridge] BRIDGE_TOKEN 未设置，服务将拒绝所有请求。');
  }

  console.log(`[sim-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[sim-bridge] public endpoints: POST ${EXPOSED_TARGET_ENDPOINTS.join(', ')}`);
});
