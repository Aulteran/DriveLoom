// A tiny software WebAuthn authenticator (ES256, "none" attestation) for tests.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const b64 = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  counter = 0;
  readonly #priv: KeyObject;
  readonly #x: Buffer;
  readonly #y: Buffer;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.#x = Buffer.from(jwk.x!, 'base64url');
    this.#y = Buffer.from(jwk.y!, 'base64url');
  }
  get id(): string { return b64(this.credentialId); }

  create(o: { challenge: string; origin: string; rpId: string; uv?: boolean }) {
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.#x], [-3, this.#y]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha(o.rpId), Buffer.from([0x01 | ((o.uv ?? true) ? 0x04 : 0) | 0x40]), Buffer.alloc(4), Buffer.alloc(16), len, this.credentialId, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin: o.origin, crossOrigin: false }));
    const att = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), attestationObject: b64(att), transports: ['internal'] } };
  }

  get(o: { challenge: string; origin: string; rpId: string; userHandle?: Buffer; uv?: boolean }) {
    const c = Buffer.alloc(4); c.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha(o.rpId), Buffer.from([0x01 | ((o.uv ?? true) ? 0x04 : 0)]), c]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: o.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.#priv);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(signature), ...(o.userHandle ? { userHandle: b64(o.userHandle) } : {}) },
    };
  }
}
