// Team tab: athletes join the coach's group and see what has been shared.
// The coach dashboard itself is a separate page (coach.html, src/coach-app.js).

import { loadTeam, resetSync, saveTeam } from './storage.js';
import { addressDetails, callSheet, isValidSheetUrl, memberAddress, syncPending, syncStatus } from './team.js';
import { esc, statusBadge } from './ui.js';

const since = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

// ---------------------------------------------------------------- athletes

export function renderTeam(view, query, rerender) {
  const $ = (sel) => view.querySelector(sel);
  const status = syncStatus();
  const invited = addressDetails(location.search, query);
  const invitedUrl = invited.url;
  const invitedGroup = invited.group;
  const returning = Boolean(invited.athlete && invitedUrl && invitedGroup);

  if (!status.joined) {
    view.innerHTML = `
      <section class="card">
        <h2>${returning ? `Finish setting up, ${esc(invited.athlete.split(' ')[0])}` : 'Share with your coach'}</h2>
        ${returning ? `<p>This copy of the app needs to reconnect to <b>${esc(invitedGroup)}</b>. Check your name and tap
          <b>Join group</b>.</p>` : ''}
        <p${returning ? ' class="muted small"' : ''}>Join your practice group so your coach can follow your recovery. Your check-ins
          (including injuries and notes) and heart readings are sent to the group’s spreadsheet,
          which only your coach can open.</p>
        <form id="join" class="stack">
          <label class="field">Your name <input name="athlete" autocomplete="name" required maxlength="60" placeholder="First and last name" value="${esc(invited.athlete)}"></label>
          <label class="field">Group code <input name="group" required value="${esc(invitedGroup)}" autocapitalize="characters"></label>
          <label class="field" ${invitedUrl ? 'hidden' : ''}>Group sheet link
            <input name="url" type="url" required value="${esc(invitedUrl)}" placeholder="https://script.google.com/macros/s/…/exec">
            <span class="muted small">Your coach’s invite link fills this in for you.</span></label>
          <p class="form-error" id="join-error" role="alert" hidden></p>
          <button class="btn block" type="submit">Join group</button>
        </form>
      </section>
      <section class="card">
        <h3>Are you the coach?</h3>
        <p class="muted small">Set up the group spreadsheet and see everyone’s readiness.</p>
        <a class="btn secondary block" href="coach.html">Open coach dashboard</a>
      </section>`;
    $('#join').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const err = $('#join-error');
      const athlete = f.athlete.value.trim();
      const group = f.group.value.trim();
      const url = f.url.value.trim();
      err.hidden = true;
      if (!athlete || !group || !isValidSheetUrl(url)) {
        err.textContent = !isValidSheetUrl(url) ? 'The group sheet link should start with https://script.google.com/' : 'Please fill in your name and group code.';
        err.hidden = false;
        return;
      }
      const btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        await callSheet(url, { action: 'ping', group });
        saveTeam({ url, group, athlete, joinedAt: new Date().toISOString() });
        resetSync(); // send the athlete's whole history to the group…
        syncPending(); // …in the background, so they can start straight away
        // Keep the group details in the address (for Add to Home Screen) and go
        // straight into today's check-in; replaceState keeps the form out of Back.
        history.replaceState(null, '', memberAddress(location.href, loadTeam(), '#morning?joined=1'));
        rerender();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false; btn.textContent = 'Join group';
      }
    });
    return;
  }

  view.innerHTML = `
    <section class="card">
      <h2>Your group</h2>
      <p>Sharing with your coach as <b>${esc(status.athlete)}</b> (group ${esc(status.group)}).</p>
      <p id="sync-line">${syncLine(status)}</p>
      <div class="actions">
        <button class="btn" id="send">Send now</button>
        <button class="btn secondary danger" id="leave">Stop sharing</button>
      </div>
    </section>
    <section class="card">
      <h3>Are you the coach?</h3>
      <a class="btn secondary block" href="coach.html">Open coach dashboard</a>
    </section>`;
  $('#send').onclick = async () => {
    $('#send').disabled = true;
    await syncPending();
    rerender();
  };
  $('#leave').onclick = () => {
    if (confirm('Stop sharing with your coach? Data already sent stays in the group sheet; your coach can remove it.')) {
      saveTeam(null);
      history.replaceState(null, '', `${location.pathname}#team`);
      rerender();
    }
  };
}

export function syncLine(status) {
  if (!status.joined) return '';
  if (status.lastError && status.pending) {
    return `${statusBadge({ level: 'warning', label: 'Not sent yet' })} ${esc(status.lastError)} It will retry automatically.`;
  }
  if (status.pending) return `${statusBadge({ level: 'warning', label: 'Sending' })} ${status.pending} day${status.pending > 1 ? 's' : ''} waiting to send.`;
  return `${statusBadge({ level: 'good', label: 'Shared with coach' })} Last sent ${since(status.lastSync)}.`;
}
