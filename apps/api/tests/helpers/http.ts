// Starts the real HTTP layer over a set of routes with the fake authenticator.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type Route } from '../../src/http/app.ts';
import { fakeAuthenticator, noProxies, ORIGIN, type TestUser } from './index.ts';

export interface Res { status: number; type: string; json: any; text: string; headers: Headers; bytes: Buffer }
export interface TestApp {
  call(as: TestUser | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  close(): void;
}

export async function startApp(users: Iterable<TestUser>, routes: Route[]): Promise<TestApp> {
  const app = createApp({ routes, authenticator: fakeAuthenticator(users), publicOrigin: ORIGIN, ipTrust: noProxies });
  const server = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async call(as, method, path, body, extra = {}) {
      const raw = body instanceof Uint8Array;
      const headers: Record<string, string> = { 'x-csrf-token': 'test-csrf', ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }), ...extra };
      if (as) headers['cookie'] = `dl_session=${as.id}`;
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body);
      const r = await fetch(base + path, init);
      const bytes = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') ?? '';
      const text = bytes.toString('utf8');
      return { status: r.status, type, json: /json/.test(type) && text ? JSON.parse(text) : undefined, text, headers: r.headers, bytes };
    },
    close() { server.close(); server.closeAllConnections(); },
  };
}
