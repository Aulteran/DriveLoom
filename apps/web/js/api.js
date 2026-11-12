// API client. Same origin, cookie session, CSRF token on every unsafe request.
// Errors are RFC 9457 problems, raised as ApiError with the stable `code`.

let csrf = null;
export const setCsrf = (t) => { csrf = t; };

export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail || problem?.title || `Request failed (${status})`);
    this.status = status; this.code = problem?.code ?? 'error'; this.problem = problem ?? {};
  }
}

/** Listeners called when the server says the session is gone. */
const onSignedOut = new Set();
export const whenSignedOut = (fn) => onSignedOut.add(fn);

export async function api(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin' };
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  if (body instanceof Blob) { init.body = body; headers['content-type'] = body.type; }
  else if (body !== undefined) { init.body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(path, init);
  if (opts.raw && res.ok) return res;
  const text = await res.text();
  const data = text && /json/.test(res.headers.get('content-type') ?? '') ? JSON.parse(text) : null;
  if (!res.ok) {
    // Only a missing or expired session signs the client out; a wrong password or code is just an error.
    if (res.status === 401 && data?.code === 'unauthenticated' && !opts.quiet) for (const fn of onSignedOut) fn();
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p, o) => api('GET', p, undefined, o);
export const post = (p, b, o) => api('POST', p, b ?? {}, o);
export const put = (p, b, o) => api('PUT', p, b, o);
export const patch = (p, b, o) => api('PATCH', p, b, o);
export const del = (p, o) => api('DELETE', p, undefined, o);

// --- WebAuthn JSON <-> browser objects (base64url) ---
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;

export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function';

export async function createPasskey(options) {
  const publicKey = {
    ...options, challenge: unb64(options.challenge), user: { ...options.user, id: unb64(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: unb64(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id, rawId: b64(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject),
      transports: cred.response.getTransports?.() ?? [],
    },
  };
}

export async function getPasskey(options) {
  const publicKey = { ...options, challenge: unb64(options.challenge), allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: unb64(c.id) })) };
  const cred = await navigator.credentials.get({ publicKey });
  return {
    id: cred.id, rawId: b64(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b64(cred.response.clientDataJSON), authenticatorData: b64(cred.response.authenticatorData),
      signature: b64(cred.response.signature), userHandle: cred.response.userHandle ? b64(cred.response.userHandle) : undefined,
    },
  };
}
