// Client address resolution. X-Forwarded-For is honoured only when the direct
// peer is a configured trusted proxy; otherwise it is ignored (spoofable).
import { BlockList, isIP } from 'node:net';

export interface IpTrust { isTrusted(addr: string): boolean }

export function trustFromList(entries: string[]): IpTrust {
  const list = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const fam = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4';
    if (!addr || !isIP(addr)) throw new Error(`invalid trusted proxy entry: ${e}`);
    if (bits !== undefined) list.addSubnet(addr, Number(bits), fam); else list.addAddress(addr, fam);
  }
  return {
    isTrusted(a) {
      const addr = a.replace(/^::ffff:/, '');
      const v = isIP(addr);
      return v !== 0 && list.check(addr, v === 6 ? 'ipv6' : 'ipv4');
    },
  };
}

export function clientIp(peer: string, xff: string | string[] | undefined, trust: IpTrust): string {
  const peerAddr = peer.replace(/^::ffff:/, '');
  if (!trust.isTrusted(peerAddr) || !xff) return peerAddr;
  const hops = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean);
  // Walk from the nearest hop; the first address that is not a trusted proxy is the client.
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i]!.replace(/^::ffff:/, '');
    if (isIP(h) === 0) return peerAddr;
    if (!trust.isTrusted(h)) return h;
  }
  return peerAddr;
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  const v = isIP(a);
  return (v === 4 && a.startsWith('127.')) || (v === 6 && a === '::1');
}

/**
 * Whether a request may carry a bearer credential: the connection itself is TLS, or the direct peer is a
 * configured trusted proxy that says it terminated TLS (the last X-Forwarded-Proto value is `https`; that
 * header from anyone else is ignored), or the client is on loopback (local development, or a proxy on the
 * same host that forwards nothing about a remote client). Plain HTTP from a remote client is refused.
 */
export function bearerTransportAllowed(
  c: { encrypted: boolean; peer: string; forwardedFor: string | string[] | undefined; forwardedProto: string | string[] | undefined },
  trust: IpTrust,
): boolean {
  if (c.encrypted) return true;
  const peer = c.peer.replace(/^::ffff:/, '');
  if (trust.isTrusted(peer)) {
    const protos = (Array.isArray(c.forwardedProto) ? c.forwardedProto.join(',') : c.forwardedProto ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (protos[protos.length - 1] === 'https') return true;
  }
  return isLoopback(clientIp(c.peer, c.forwardedFor, trust));
}
