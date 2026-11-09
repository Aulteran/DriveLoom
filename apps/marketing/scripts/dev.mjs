import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import './build.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = { '.html': 'text/html', '.css': 'text/css' };
createServer(async (req, res) => {
  const p = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  const f = join(dist, p.endsWith('/') ? p + 'index.html' : p);
  try { const ext = f.slice(f.lastIndexOf('.')); res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' }); res.end(await readFile(f)); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(4321, () => console.log('http://localhost:4321'));
