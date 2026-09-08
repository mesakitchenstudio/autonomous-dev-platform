const $ = s => document.querySelector(s);
const projects = $('#projects');
const inbox = $('#inbox');

function esc(v = '') {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function token() {
  const input = $('#token');
  const stored = localStorage.getItem('adpOwnerToken') || '';
  if (input && !input.value) input.value = stored;
  return (input?.value || stored || '').trim();
}

function headers(extra = {}) {
  const t = token();
  if (t) localStorage.setItem('adpOwnerToken', t);
  return { ...extra, ...(t ? { authorization: 'Bearer ' + t } : {}) };
}

function statusClass(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW') return 'ready';
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') return 'done';
  if (p.state === 'FAILED') return 'failed';
  return 'progress';
}

function stageLabel(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW') return 'Ready for your review';
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') return 'Completed';
  if (p.state === 'FAILED') return 'Paused';
  if (p.state === 'OWNER_CHANGES_REQUESTED') return 'Changes requested — autonomous work resumed';
  if (p.state === 'RUNTIME_VERIFICATION') return 'Runtime verification';
  if (p.state === 'VISUAL_VERIFICATION') return 'Visual verification';
  if (p.state === 'PLATFORM_VERIFICATION') return 'Build and test verification';
  if (p.state === 'DELIVERY_PREPARATION') return 'Preparing your delivery';
  if (p.state === 'CURSOR_EXECUTING') return 'Implementing';
  if (p.state === 'PROJECT_PROVISIONING') return 'Creating the project';
  if (p.state === 'COUNCIL_DISCOVERY' || p.state === 'COUNCIL_REVIEW' || p.state === 'FINAL_VERIFICATION') return 'Reviewing the work';
  return 'Building your project';
}

function checkLine(label, card) {
  if (!card) return `${label} — Not applicable`;
  if (card.status === 'PASS') return `${label} ✓ ${card.label}`;
  if (card.status === 'NOT_APPLICABLE') return `${label} — ${card.label}`;
  return `${label} — ${card.label}`;
}

function readyCard(p) {
  const d = p.delivery || {};
  const v = d.verification || {};
  const shots = (d.screenshots || []).map(item => `<img alt="${esc(item.fileName || 'screenshot')}" src="/api/projects/${p.id}/artifacts/${item.id}">`).join('');
  const limits = (d.knownLimitations || []).map(item => `<li>${esc(item)}</li>`).join('');
  const tests = (d.testingGuidance || []).map(item => `<li>${esc(item)}</li>`).join('');
  const downloads = (d.artifacts || []).filter(item => item.kind === 'SOURCE_ARCHIVE' || item.kind === 'BUILD')
    .map(item => `<button class="secondary" data-dl="${item.id}">${item.kind === 'BUILD' ? 'Download Build' : 'Download Source'}</button>`).join('');
  return `
    <p class="headline">All required automated verification has completed.</p>
    <div class="actions">
      <button data-open="1">Open App</button>
      ${downloads}
    </div>
    ${shots ? `<div><h4>Screenshots</h4><div class="shots">${shots}</div></div>` : ''}
    <div>
      <h4>Verification</h4>
      <ul class="checks">
        <li>${esc(checkLine('Build', v.build))}</li>
        <li>${esc(checkLine('Automated tests', v.tests))}</li>
        <li>${esc(checkLine('Runtime', v.runtime))}</li>
        <li>${esc(checkLine('Critical user flows', v.journeys))}</li>
        <li>${esc(checkLine('Accessibility', v.accessibility))}</li>
        <li>${esc(checkLine('Visual review', v.visual))}</li>
        <li>${esc(checkLine('Security', v.security))}</li>
      </ul>
    </div>
    <div>
      <h4>Things worth checking</h4>
      <ul class="limits">${tests || '<li>Open the application and confirm it matches what you asked for.</li>'}</ul>
    </div>
    <div>
      <h4>Known limitations</h4>
      <ul class="limits">${limits || '<li>None recorded.</li>'}</ul>
    </div>
    <details class="tech"><summary>Technical details</summary>
      <pre>${esc([
        `Checkpoint: ${d.checkpointSha || 'n/a'}`,
        `Delivery: v${d.version || 1}`,
        `Manifest: ${d.manifestHash || 'n/a'}`,
        d.workingBranch ? `Branch: ${d.workingBranch}` : ''
      ].filter(Boolean).join('\n'))}</pre>
    </details>
    <div class="actions">
      <button data-approve="1">Approve</button>
      <button class="secondary" data-changes="1">Request Changes</button>
    </div>
    <textarea class="feedback" placeholder="Describe the change in plain language. You do not need technical instructions."></textarea>
  `;
}

function activeCard(p) {
  if (p.state === 'FAILED') {
    return `<p class="headline">Development paused due to an infrastructure issue.</p><p class="meta">No technical action is required from you unless the operator asks.</p>`;
  }
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') {
    return `<p class="headline">This project is complete.</p><p class="meta">Approval accepted the autonomous result. It did not deploy or publish anything.</p>`;
  }
  if (p.state === 'OWNER_CHANGES_REQUESTED') {
    return `<p class="headline">Changes requested — autonomous work resumed.</p><p class="meta">No action required.</p>`;
  }
  return `<p class="headline">Building your project</p><p class="meta">Current stage: ${esc(stageLabel(p))}</p><p class="meta">No action required.</p>`;
}

function cardHtml(p) {
  const name = p.delivery?.productName || p.council?.discovery?.spec?.productName || 'New project';
  const body = p.state === 'READY_FOR_OWNER_REVIEW' ? readyCard(p) : activeCard(p);
  return `<article class="card" data-id="${p.id}"><div><h3>${esc(name)}</h3><div class="meta">${esc(p.idea)}</div></div><div class="status ${statusClass(p)}">${esc(stageLabel(p))}</div>${body}</article>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadInbox() {
  try {
    const notes = await api('/api/notifications');
    const unread = (notes || []).filter(item => !item.readAt && item.type === 'READY_FOR_OWNER_REVIEW');
    if (!unread.length) {
      inbox.hidden = true;
      inbox.innerHTML = '';
      return;
    }
    inbox.hidden = false;
    inbox.innerHTML = unread.map(item => `<p><strong>${esc(item.title)}</strong> <a href="#project-${item.projectId}" data-read="${item.id}">Open review</a></p>`).join('');
  } catch {
    inbox.hidden = true;
  }
}

async function load() {
  $('#error').textContent = '';
  try {
    const list = await api('/api/projects');
    if (!Array.isArray(list)) {
      projects.innerHTML = '<p>Authentication required.</p>';
      return;
    }
    await loadInbox();
    projects.innerHTML = list.length ? list.map(cardHtml).join('') : '<p>No projects yet.</p>';
  } catch {
    projects.innerHTML = '<p>Authentication required.</p>';
  }
}

$('#submit').onclick = async () => {
  $('#error').textContent = '';
  const idea = $('#idea').value.trim();
  if (!idea) return $('#error').textContent = 'Describe the application or change first.';
  if (!token()) return $('#error').textContent = 'Owner API token is required.';
  try {
    await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea, projectPath: $('#path').value.trim() || null })
    });
    $('#idea').value = '';
    await load();
  } catch (error) {
    $('#error').textContent = error.message;
  }
};

$('#refresh').onclick = load;

projects.addEventListener('click', async event => {
  const card = event.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  try {
    if (event.target.dataset.open) {
      const session = await api(`/api/projects/${id}/review-session`, { method: 'POST' });
      window.open(session.reviewUrl, '_blank', 'noopener');
    }
    if (event.target.dataset.approve) {
      await api(`/api/projects/${id}/approve`, { method: 'POST' });
      await load();
    }
    if (event.target.dataset.changes) {
      const feedback = card.querySelector('.feedback')?.value.trim();
      if (!feedback) return $('#error').textContent = 'Add a short description of the change.';
      await api(`/api/projects/${id}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback })
      });
      await load();
    }
    if (event.target.dataset.dl) {
      const res = await fetch(`/api/projects/${id}/artifacts/${event.target.dataset.dl}`, { headers: headers() });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = event.target.textContent.includes('Build') ? 'build.bin' : 'source.zip';
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    $('#error').textContent = error.message;
  }
});

inbox.addEventListener('click', async event => {
  const id = event.target.dataset.read;
  if (!id) return;
  try { await api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
});

load();
setInterval(load, 5000);
