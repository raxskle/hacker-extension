import { requestCaptureAppend } from '../shared/capture';

type BridgeMessagePayload = {
  source: 'fetch' | 'xhr' | 'beacon';
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

const BRIDGE_SOURCE = 'hacker-extension-recorder';

function isBridgePayload(value: unknown): value is BridgeMessagePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Partial<BridgeMessagePayload>;
  return (
    (payload.source === 'fetch' || payload.source === 'xhr' || payload.source === 'beacon') &&
    typeof payload.timestamp === 'number' &&
    typeof payload.url === 'string' &&
    typeof payload.method === 'string' &&
    typeof payload.status === 'number' &&
    typeof payload.contentType === 'string' &&
    typeof payload.requestBody === 'string' &&
    typeof payload.responseBody === 'string' &&
    (payload.responseEncoding === 'text' || payload.responseEncoding === 'unavailable') &&
    typeof payload.responseTruncated === 'boolean' &&
    typeof payload.requestHeaders === 'object' &&
    payload.requestHeaders !== null &&
    typeof payload.responseHeaders === 'object' &&
    payload.responseHeaders !== null &&
    typeof payload.error === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) {
    return;
  }

  if (typeof event.data !== 'object' || event.data === null) {
    return;
  }

  const data = event.data as { source?: unknown; payload?: unknown };
  if (data.source !== BRIDGE_SOURCE || !isBridgePayload(data.payload)) {
    return;
  }

  void requestCaptureAppend(data.payload).catch(() => {
    // Ignore per-event bridge failures to avoid breaking host pages.
  });
});
