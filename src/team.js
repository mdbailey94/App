// Talking to the group's Google Sheet (see apps-script/Code.gs).

import { assessDay, sessionLoad, wellnessScore } from './readiness.js';
import { loadEntries, loadTeam, markSynced, saveTeam } from './storage.js';

// Apps Script web apps accept a plain-text POST without a CORS preflight and
// answer with JSON after a redirect.
// `leaving`: the athlete is closing or switching away from the app. Then the
// request is sent with keepalive so it can finish after the page is gone
// (browsers allow that for small requests only). Some browsers have refused
// keepalive requests that, like Apps Script, answer with a redirect, so a
// keepalive failure is retried as a normal request.
export async function callSheet(url, body, { leaving = false } = {}) {
  const text = JSON.stringify(body);
  const send = (keepalive) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: text,
    redirect: 'follow',
    keepalive,
  });
  let res;
  try {
    const keepalive = leaving && text.length < 60000;
    res = await send(keepalive).catch((err) => { if (keepalive) return send(false); throw err; });
  } catch {
    throw new Error('Couldn’t reach the group sheet. Check your internet connection.');
  }
  if (!res.ok) throw new Error(`The group sheet isn’t responding right now (error ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('That link doesn’t look like the group sheet’s web app link.');
  }
  if (!data.ok) throw new Error(data.error || 'The group sheet refused the request.');
  return data;
}

export function isValidSheetUrl(url) {
  return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(String(url || '').trim())
    || /^http:\/\/localhost(:\d+)?\//.test(String(url || '').trim()); // local testing
}

export function pendingEntries(entries) {
  return entries.filter((e) => !e.syncedAt || (e.updatedAt && e.syncedAt < e.updatedAt));
}

// What gets sent for each day: the raw entry plus the readiness the athlete saw.
export function buildItems(allEntries, entries) {
  return entries.map(({ syncedAt, ...entry }) => {
    const a = assessDay(allEntries, entry.date);
    return {
      entry,
      summary: {
        score: a.score,
        status: a.status?.label ?? null,
        flags: a.flags.map((f) => f.text),
        wellness: wellnessScore(entry.wellness),
        load: sessionLoad(entry.training),
      },
    };
  });
}

let inflight = null;

// Send anything new or edited. Safe to call often: does nothing when there is
// nothing to send, and only one sync runs at a time. A call made while one is
// running (say, a check-in saved mid-send) runs another round straight after,
// so nothing saved in the meantime waits for the next chance.
export function syncPending(opts = {}) {
  if (inflight) return inflight.then(() => syncPending(opts));
  inflight = (async () => {
    const team = loadTeam();
    if (!team) return { state: 'off' };
    const entries = loadEntries();
    const pending = pendingEntries(entries);
    if (!pending.length) return { state: 'synced' };
    const stamp = new Date().toISOString();
    try {
      const items = buildItems(entries, pending);
      for (let i = 0; i < items.length; i += 100) {
        const res = await callSheet(team.url, {
          action: 'submit', group: team.group, athlete: team.athlete, items: items.slice(i, i + 100),
        }, opts);
        markSynced(res.saved || [], stamp);
      }
      saveTeam({ ...loadTeam(), lastSync: stamp, lastError: null, failingSince: null });
      return { state: 'synced' };
    } catch (err) {
      const t = loadTeam();
      if (t) saveTeam({ ...t, lastError: err.message, failingSince: t.failingSince || stamp });
      return { state: 'error', error: err.message };
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

// Sending has failed for a day or more: probably not a passing network blip
// (e.g. the coach set up a new sheet link), so the athlete needs to act.
export function stuck(status, now = Date.now()) {
  return Boolean(status.pending && status.failingSince && now - new Date(status.failingSince) > 24 * 3600e3);
}

export function syncStatus() {
  const team = loadTeam();
  if (!team) return { joined: false };
  return { joined: true, ...team, pending: pendingEntries(loadEntries()).length };
}

// Group details live in the page address as well as this browser's storage.
// On iPhone a Home Screen app gets fresh storage but keeps the address it was
// added from, so carrying u (sheet link), g (group code) and n (name) there
// lets the installed app finish joining with one tap.
const appBase = (url) => url.split(/[?#]/)[0];

// Invite link the coach shares; opening it pre-fills the athlete's Team tab.
export function inviteLink(appUrl, sheetUrl, group) {
  return `${appBase(appUrl)}?${new URLSearchParams({ u: sheetUrl, g: group })}#team`;
}

// The address to keep once an athlete has joined.
export function memberAddress(appUrl, team, hash = '') {
  return `${appBase(appUrl)}?${new URLSearchParams({ u: team.url, g: team.group, n: team.athlete })}${hash}`;
}

// Group details from the address (query string, or the older #team?… form).
export function addressDetails(search, hashQuery) {
  const a = new URLSearchParams(search);
  const pick = (k) => hashQuery?.get(k) || a.get(k) || '';
  return { url: pick('u'), group: pick('g'), athlete: pick('n') };
}
