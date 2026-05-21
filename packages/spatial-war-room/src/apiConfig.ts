const DEFAULT_HTTP_URL = 'http://localhost:8080';
const DEFAULT_WS_URL = 'ws://localhost:8080';

export const ORCHESTRATOR_HTTP_URL = import.meta.env.VITE_KOVAEL_HTTP_URL ?? DEFAULT_HTTP_URL;

const baseWsUrl = import.meta.env.VITE_KOVAEL_WS_URL ?? DEFAULT_WS_URL;
const apiToken = import.meta.env.VITE_KOVAEL_API_TOKEN ?? '';

export function authHeaders(): Record<string, string> {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

export function websocketUrl(): string {
  if (!apiToken) return baseWsUrl;
  const url = new URL(baseWsUrl);
  url.searchParams.set('token', apiToken);
  return url.toString();
}
