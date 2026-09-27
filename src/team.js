// Talking to the group's Google Sheet (see apps-script/Code.gs).

import { assessDay, sessionLoad, wellnessScore } from './readiness.js';
import { loadEntries, loadTeam, markSynced, saveTeam } from './storage.js';

// Apps Script web apps accept a plain-text POST without a CORS preflight and
// answer with JSON after a redirect.
export async function callSheet(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
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
// nothing to send, and only one sync runs at a time.
export function syncPending() {
  if (inflight) return inflight;
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
        });
        markSynced(res.saved || [], stamp);
      }
      saveTeam({ ...loadTeam(), lastSync: stamp, lastError: null });
      return { state: 'synced' };
    } catch (err) {
      if (loadTeam()) saveTeam({ ...loadTeam(), lastError: err.message });
      return { state: 'error', error: err.message };
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

export function syncStatus() {
  const team = loadTeam();
  if (!team) return { joined: false };
  return { joined: true, ...team, pending: pendingEntries(loadEntries()).length };
}

// Invite link the coach shares; opening it pre-fills the athlete's Team tab.
export function inviteLink(appUrl, sheetUrl, group) {
  const base = appUrl.split('#')[0];
  return `${base}#team?u=${encodeURIComponent(sheetUrl)}&g=${encodeURIComponent(group)}`;
}
