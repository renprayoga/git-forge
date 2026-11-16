// Shared request/response plumbing for the forge's HTTP surfaces.

import type { Store } from './store.ts';

export interface ReqCtx {
  store: Store;
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  bodyText: string;
  body: unknown;
  bodyError: boolean;
  authed: boolean;
  requestId: string;
  /** The request's origin, e.g. http://127.0.0.1:3101 — Link headers must be absolute. */
  origin: string;
}

export interface Resp {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonResp(status: number, value: unknown, headers: Record<string, string> = {}): Resp {
  return { status, body: JSON.stringify(value), contentType: 'application/json; charset=utf-8', headers };
}

export function jsonText(status: number, text: string, headers: Record<string, string> = {}): Resp {
  return { status, body: text, contentType: 'application/json; charset=utf-8', headers };
}

export function errResp(status: number, message: string): Resp {
  return jsonResp(status, { message });
}

export function notFound(): Resp {
  return errResp(404, 'Not Found');
}

export function unauthorized(): Resp {
  return errResp(401, 'Requires authentication');
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Parse a page/per_page pair the way GitHub does (per_page 1..100, default 30). */
export function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/** Paginate `items`, returning the page and a GitHub-style Link header value (or ''). */
export function paginate<T>(items: readonly T[], page: number, perPage: number, baseUrl: string): { pageItems: T[]; link: string } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const url = (p: number): string => `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${p}&per_page=${perPage}`;
  if (page < pages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(pages)}>; rel="last"`);
  return { pageItems, link: links.join(', ') };
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

export function isoNow(): string {
  return new Date().toISOString();
}
