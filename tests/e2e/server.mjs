// Serves the app for the browser tests, plus fake group sheets: every path
// under /exec/<name> is its own copy of apps-script/Code.gs running on the
// in-memory Sheets imitation, so tests don't share data.
//   POST /__sheet/<name>  {"down": true}  make that sheet fail with 503s
//                         {"delay": ms}   make it answer slowly
//   GET  /__sheet/<name>                  { rows } – rows in its Entries tab
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppsScript } from '../support/apps-script-sim.mjs';
import { COACH_PASSWORD, GROUP_CODE, PORT as DEFAULT_PORT } from './constants.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.gs': 'text/plain',
};

const sheets = new Map();
const sheet = (name) => {
  if (!sheets.has(name)) sheets.set(name, { sim: loadAppsScript({ groupCode: GROUP_CODE, coachPassword: COACH_PASSWORD }), down: false, delay: 0 });
  return sheets.get(name);
};
const body = async (req) => { let s = ''; for await (const c of req) s += c; return s; };
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const [, kind, name] = url.pathname.split('/');
  if (kind === 'exec' && name) {
    const s = sheet(name);
    if (req.method === 'OPTIONS') return json(res, {});
    if (s.down) return json(res, { ok: false, error: 'down' }, 503);
    if (s.delay) await new Promise((r) => setTimeout(r, s.delay));
    return json(res, s.sim.post(await body(req)));
  }
  if (kind === '__sheet' && name) {
    const s = sheet(name);
    if (req.method === 'POST') {
      const change = JSON.parse(await body(req) || '{}');
      s.down = Boolean(change.down);
      s.delay = Number(change.delay) || 0;
    }
    return json(res, { rows: Math.max(0, (s.sim.sheets.get('Entries')?.rows.length ?? 1) - 1), down: s.down });
  }
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname).replace(/\/$/, '/index.html')));
  if (!path.startsWith(ROOT) || /node_modules|\.git\b/.test(path)) { res.writeHead(404); return res.end(); }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
}).listen(PORT, () => console.log(`test server on http://localhost:${PORT}/`));
