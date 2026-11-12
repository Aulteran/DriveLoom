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
