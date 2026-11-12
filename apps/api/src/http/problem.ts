// RFC 9457 problem details. Every non-2xx API response is one of these.
import { AuthError } from '../identity.ts';

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, title: string, detail?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    this.status = status;
    this.code = code;
    this.title = title;
    this.extra = extra;
    this.headers = headers;
  }
}

const AUTH_TITLES: Record<AuthError['code'], string> = {
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  csrf_failed: 'Request failed anti-forgery checks',
  reauth_required: 'Recent authentication required',
};

export function toProblem(err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  if (err instanceof AuthError) return new HttpProblem(err.status, err.code, AUTH_TITLES[err.code]);
  return new HttpProblem(500, 'internal_error', 'Internal server error');
}

export function problemBody(p: HttpProblem): Record<string, unknown> {
  return { type: 'about:blank', title: p.title, status: p.status, code: p.code, ...(p.message !== p.title ? { detail: p.message } : {}), ...p.extra };
}
