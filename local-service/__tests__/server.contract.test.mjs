import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'local-service', 'server.mjs');
const HOST = '127.0.0.1';
const TEST_EXTENSION_ID = 'test-extension-id';

function nextPort() {
  return 18000 + Math.floor(Math.random() * 2000);
}

function createServerProcess(port, token) {
  return spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BRIDGE_HOST: HOST,
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForServerReady(child, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server start timeout on port ${port}`));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = String(chunk ?? '');
      if (text.includes('listening on')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve();
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready: code=${code} signal=${signal}`));
    });
  });
}

async function stopServer(child) {
  if (child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3_000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

async function withServer(run) {
  const token = `test-token-${Math.random().toString(36).slice(2, 10)}`;
  const port = nextPort();
  const child = createServerProcess(port, token);
  const baseUrl = `http://${HOST}:${port}`;

  await waitForServerReady(child, port);

  try {
    await run({ baseUrl, token });
  } finally {
    await stopServer(child);
  }
}

async function postJson(url, token, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body ?? {}),
  });

  const json = await response.json();
  return { response, json };
}

async function bridgeRoundTrip({ baseUrl, token, endpointPath, requestBody, endpointQuery = '' }) {
  const apiPromise = postJson(`${baseUrl}${endpointPath}${endpointQuery}`, token, requestBody);

  const poll = await postJson(
    `${baseUrl}/v1/extension/poll`,
    token,
    { maxWaitMs: 3_000 },
    { 'x-extension-id': TEST_EXTENSION_ID },
  );

  assert.equal(poll.response.status, 200, 'poll should return job');
  const job = poll.json;
  assert.equal(typeof job.id, 'string');
  assert.equal(typeof job.path, 'string');

  const finalUrl = `${job.origin}${job.path}`;
  const resultAck = await postJson(
    `${baseUrl}/v1/extension/result`,
    token,
    {
      id: job.id,
      ok: true,
      payload: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        truncated: false,
        finalUrl,
      },
    },
    { 'x-extension-id': TEST_EXTENSION_ID },
  );

  assert.equal(resultAck.response.status, 200, 'result ack should be accepted');

  const api = await apiPromise;
  return { job, api };
}

function getSearchParams(pathWithQuery) {
  const url = new URL(pathWithQuery, 'https://example.com');
  return url.searchParams;
}

test('suggest forwards page=2 and explicit orderBy', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job, api } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/KeywordGenerator/google/suggest',
      requestBody: {
        keyword: 'image to text',
        country: '999',
        latest: '28d',
        page: 2,
        rowsPerPage: 100,
        sort: 'windowVolume',
        asc: false,
        orderBy: 'windowVolume desc',
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('page'), '2');
    assert.equal(params.get('orderBy'), 'windowVolume desc');
    assert.equal(params.get('rowsPerPage'), '100');

    assert.equal(api.response.status, 200);
    assert.equal(api.json.ok, true);
    assert.match(api.json.data.finalUrl, /page=2/);
  });
});

test('suggest derives orderBy from sort+asc when missing', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/KeywordGenerator/google/suggest',
      requestBody: {
        keyword: 'image to text',
        sort: 'windowVolume',
        asc: false,
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('orderBy'), 'windowVolume desc');
  });
});

test('endpoint merges query and body with body precedence', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/KeywordGenerator/google/suggest',
      endpointQuery: '?keyword=query-keyword&page=2&rowsPerPage=80&asc=true',
      requestBody: {
        keyword: 'body-keyword',
        page: 3,
        rowsPerPage: 90,
        asc: false,
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('keyword'), 'body-keyword');
    assert.equal(params.get('page'), '3');
    assert.equal(params.get('rowsPerPage'), '90');
    assert.equal(params.get('asc'), 'false');
  });
});

test('landing pages accepts lowercase websource alias', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/websiteOrganicLandingPagesV2',
      requestBody: {
        key: 'vercel.app',
        websource: 'MobileWeb',
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('webSource'), 'MobileWeb');
  });
});

test('sim endpoints ignore requestBody override', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/KeywordGenerator/google/suggest',
      requestBody: {
        keyword: 'image to text',
        requestBody: '{"override":true}',
      },
    });

    assert.equal(job.body, '[]');
  });
});

test('sem endpoints still validate JSON-RPC method', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { response, json } = await postJson(`${baseUrl}/sem/kmtgw/v2/webapi/ideas.GetKeywords`, token, {
      __gmitm: 'demo-token',
      requestBody: {
        id: 1,
        jsonrpc: '2.0',
        method: 'ideas.GetKeywordsSummary',
        params: {},
      },
    });

    assert.equal(response.status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'INVALID_PARAMS');
    assert.match(json.error.message, /requestBody\.method 必须为 ideas\.GetKeywords/);
  });
});



test('landing pages forwards full optional field set', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/websiteOrganicLandingPagesV2',
      requestBody: {
        key: 'vercel.app',
        country: '840',
        latest: '3m',
        from: '2026|06|01',
        to: '2026|07|01',
        websource: 'MobileWeb',
        sourceType: 'organic',
        sort: 'ClicksShare',
        asc: true,
        includeSubDomains: false,
        isWindow: true,
        page: 4,
        searchType: 'subdomain',
        orderBy: 'ClicksShare asc',
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('key'), 'vercel.app');
    assert.equal(params.get('country'), '840');
    assert.equal(params.get('latest'), '3m');
    assert.equal(params.get('from'), '2026|06|01');
    assert.equal(params.get('to'), '2026|07|01');
    assert.equal(params.get('webSource'), 'MobileWeb');
    assert.equal(params.get('sourceType'), 'organic');
    assert.equal(params.get('sort'), 'ClicksShare');
    assert.equal(params.get('asc'), 'true');
    assert.equal(params.get('includeSubDomains'), 'false');
    assert.equal(params.get('isWindow'), 'true');
    assert.equal(params.get('page'), '4');
    assert.equal(params.get('orderBy'), 'ClicksShare asc');

    const pageFilterJson = params.get('pageFilterJson');
    assert.equal(typeof pageFilterJson, 'string');
    assert.ok(pageFilterJson?.includes('"searchType":"subdomain"'));
  });
});

test('drilldown forwards full optional field set', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sim/api/websiteOrganicLandingPagesV2/GetTableDrillDown',
      requestBody: {
        key: 'vercel.app',
        landingPage: 'vercel.app/docs',
        country: '840',
        latest: '3m',
        from: '2026|06|01',
        to: '2026|07|01',
        websource: 'Desktop',
        sourceType: 'organic',
        sort: 'ClicksShare',
        asc: true,
        rowsPerPage: 120,
        includeSubDomains: false,
        isWindow: true,
        searchType: 'subdomain',
        change: 'Lost',
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(job.method, 'GET');
    assert.equal(params.get('key'), 'vercel.app');
    assert.equal(params.get('landingPage'), 'vercel.app/docs');
    assert.equal(params.get('country'), '840');
    assert.equal(params.get('latest'), '3m');
    assert.equal(params.get('from'), '2026|06|01');
    assert.equal(params.get('to'), '2026|07|01');
    assert.equal(params.get('webSource'), 'Desktop');
    assert.equal(params.get('sourceType'), 'organic');
    assert.equal(params.get('sort'), 'ClicksShare');
    assert.equal(params.get('asc'), 'true');
    assert.equal(params.get('rowsPerPage'), '120');
    assert.equal(params.get('includeSubDomains'), 'false');
    assert.equal(params.get('isWindow'), 'true');
  });
});



test('sem supports gmitm alias from query', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { job } = await bridgeRoundTrip({
      baseUrl,
      token,
      endpointPath: '/sem/kmtgw/v2/webapi/ideas.GetKeywords',
      endpointQuery: '?gmitm=query-alias-token',
      requestBody: {
        requestBody: {
          id: 1,
          jsonrpc: '2.0',
          method: 'ideas.GetKeywords',
          params: { phrase: 'image to text' },
        },
      },
    });

    const params = getSearchParams(job.path);
    assert.equal(params.get('__gmitm'), 'query-alias-token');
  });
});

test('invalid page value returns INVALID_PARAMS', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const { response, json } = await postJson(`${baseUrl}/sim/api/KeywordGenerator/google/suggest`, token, {
      keyword: 'image to text',
      page: 'not-a-number',
    });

    assert.equal(response.status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'INVALID_PARAMS');
    assert.match(json.error.message, /page 必须为数字/);
  });
});
