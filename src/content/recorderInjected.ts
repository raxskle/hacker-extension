type CaptureSourceType = 'fetch' | 'xhr';

export {};

type CapturePayload = {
  source: CaptureSourceType;
  timestamp: number;
  url: string;
  method: string;
  status: number;
  contentType: string;
  requestBody: string;
  responseBody: string;
  responseEncoding: 'text' | 'unavailable';
  responseTruncated: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  error: string;
};

declare global {
  interface Window {
    __HACKER_EXTENSION_CAPTURE_PATCHED__?: boolean;
  }
}

const BRIDGE_SOURCE = 'hacker-extension-recorder';
const MAX_CAPTURE_CHARS = 200_000;

function toTextSnippet(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof URLSearchParams) {
    return value.toString();
  }

  if (value instanceof FormData) {
    return '[FormData]';
  }

  if (value instanceof Blob) {
    return `[Blob:${value.type || 'unknown'}:${value.size}]`;
  }

  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer:${value.byteLength}]`;
  }

  if (ArrayBuffer.isView(value)) {
    return `[TypedArray:${value.byteLength}]`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_CAPTURE_CHARS) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, MAX_CAPTURE_CHARS)}\n...[truncated ${value.length - MAX_CAPTURE_CHARS} chars]`,
    truncated: true,
  };
}

function headersToRecord(headers: Headers | null | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(headers.entries());
}

function normalizeFetchHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) {
    return {};
  }

  if (input instanceof Headers) {
    return headersToRecord(input);
  }

  if (Array.isArray(input)) {
    return Object.fromEntries(input.map(([key, value]) => [key, String(value)]));
  }

  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

function parseRawHeaders(raw: string): Record<string, string> {
  if (!raw) {
    return {};
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const entries = lines.map((line) => {
    const splitIndex = line.indexOf(':');
    if (splitIndex < 0) {
      return [line.trim(), ''] as const;
    }
    return [line.slice(0, splitIndex).trim(), line.slice(splitIndex + 1).trim()] as const;
  });

  return Object.fromEntries(entries.filter(([key]) => key));
}

function emitCapture(payload: CapturePayload): void {
  window.postMessage({ source: BRIDGE_SOURCE, payload }, '*');
}

function patchFetch(): void {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : request?.url ?? '';
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const requestHeaders = {
      ...headersToRecord(request?.headers),
      ...normalizeFetchHeaders(init?.headers),
    };
    const requestBody = toTextSnippet(init?.body);

    try {
      const response = await originalFetch.call(window, input, init);
      const responseHeaders = headersToRecord(response.headers);
      const contentType = response.headers.get('content-type')?.trim() ?? '';

      let responseBody = '';
      let responseEncoding: CapturePayload['responseEncoding'] = 'text';
      let responseTruncated = false;
      let error = '';

      try {
        const text = await response.clone().text();
        const truncated = truncateText(text);
        responseBody = truncated.text;
        responseTruncated = truncated.truncated;
      } catch (readError) {
        responseEncoding = 'unavailable';
        error = readError instanceof Error ? readError.message : 'response body unreadable';
      }

      emitCapture({
        source: 'fetch',
        timestamp: Date.now(),
        url,
        method,
        status: response.status,
        contentType,
        requestBody,
        responseBody,
        responseEncoding,
        responseTruncated,
        requestHeaders,
        responseHeaders,
        error,
      });

      return response;
    } catch (error) {
      emitCapture({
        source: 'fetch',
        timestamp: Date.now(),
        url,
        method,
        status: 0,
        contentType: '',
        requestBody,
        responseBody: '',
        responseEncoding: 'unavailable',
        responseTruncated: false,
        requestHeaders,
        responseHeaders: {},
        error: error instanceof Error ? error.message : 'fetch failed',
      });
      throw error;
    }
  };
}

type XhrCaptureMeta = {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
};

const XHR_META_KEY = '__hacker_capture_meta__';

type CaptureXhr = XMLHttpRequest & {
  [XHR_META_KEY]?: XhrCaptureMeta;
};

function patchXhr(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: CaptureXhr,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const nextUrl = typeof url === 'string' ? url : url.href;
    this[XHR_META_KEY] = {
      method: (method || 'GET').toUpperCase(),
      url: nextUrl,
      requestHeaders: {},
      requestBody: '',
    };

    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
    this: CaptureXhr,
    name: string,
    value: string,
  ): void {
    const meta = this[XHR_META_KEY];
    if (meta) {
      meta.requestHeaders[name] = value;
    }

    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(this: CaptureXhr, body?: XMLHttpRequestBodyInit | null): void {
    const meta =
      this[XHR_META_KEY] ??
      ({ method: 'GET', url: this.responseURL || '', requestHeaders: {}, requestBody: '' } satisfies XhrCaptureMeta);
    meta.requestBody = toTextSnippet(body ?? '');
    this[XHR_META_KEY] = meta;

    this.addEventListener(
      'loadend',
      () => {
        const finalMeta = this[XHR_META_KEY] ?? meta;
        const contentType = this.getResponseHeader('content-type')?.trim() ?? '';
        const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());

        let responseBody = '';
        let responseEncoding: CapturePayload['responseEncoding'] = 'text';
        let responseTruncated = false;
        let error = '';

        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const text = this.responseText ?? '';
            const truncated = truncateText(text);
            responseBody = truncated.text;
            responseTruncated = truncated.truncated;
          } else if (this.responseType === 'json') {
            const text = toTextSnippet(this.response);
            const truncated = truncateText(text);
            responseBody = truncated.text;
            responseTruncated = truncated.truncated;
          } else {
            responseEncoding = 'unavailable';
            responseBody = `[${this.responseType || 'binary'} response not captured]`;
          }
        } catch (readError) {
          responseEncoding = 'unavailable';
          error = readError instanceof Error ? readError.message : 'xhr response unreadable';
        }

        emitCapture({
          source: 'xhr',
          timestamp: Date.now(),
          url: this.responseURL || finalMeta.url,
          method: finalMeta.method,
          status: this.status,
          contentType,
          requestBody: finalMeta.requestBody,
          responseBody,
          responseEncoding,
          responseTruncated,
          requestHeaders: finalMeta.requestHeaders,
          responseHeaders,
          error,
        });
      },
      { once: true },
    );

    return originalSend.call(this, body);
  };
}

if (!window.__HACKER_EXTENSION_CAPTURE_PATCHED__) {
  window.__HACKER_EXTENSION_CAPTURE_PATCHED__ = true;
  patchFetch();
  patchXhr();
}
