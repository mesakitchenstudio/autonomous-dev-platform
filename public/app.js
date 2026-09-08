const $ = s => document.querySelector(s);
const projects = $('#projects');
const inbox = $('#inbox');
const POLL_MS = 5000;
const EXPANDED_KEY = 'adpExpandedProject';
const uiState = new Map();
let lastProjects = [];
let pendingFocusId = null;

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

function expandedProjectId() {
  return sessionStorage.getItem(EXPANDED_KEY) || '';
}

function setExpandedProjectId(id) {
  if (id) sessionStorage.setItem(EXPANDED_KEY, id);
  else sessionStorage.removeItem(EXPANDED_KEY);
}

function memory(id) {
  return uiState.get(id) || {};
}

function draftKey(id) {
  return `adpDraft:${id}`;
}

function patchMemory(id, patch) {
  const next = { ...memory(id), ...patch };
  uiState.set(id, next);
  if (Object.prototype.hasOwnProperty.call(patch, 'feedback')) {
    if (patch.feedback) sessionStorage.setItem(draftKey(id), patch.feedback);
    else sessionStorage.removeItem(draftKey(id));
  }
  return next;
}

function statusClass(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW') return 'ready';
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') return 'done';
  if (p.state === 'FAILED') return 'failed';
  return 'progress';
}

function applyingRequestedChanges(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW' || p.state === 'DONE' || p.state === 'OWNER_APPROVED' || p.state === 'FAILED') return false;
  if (p.state === 'OWNER_CHANGES_REQUESTED') return true;
  if ((p.ownerFeedback || []).length || (p.ownerReviews || []).some(item => item.decision === 'CHANGES_REQUESTED')) return true;
  return (p.deliveries || []).some(item => item.status === 'SUPERSEDED');
}

function stageLabel(p) {
  const state = p.state;
  if (state === 'READY_FOR_OWNER_REVIEW') return 'Ready for review';
  if (state === 'DONE' || state === 'OWNER_APPROVED') return 'Complete';
  if (state === 'FAILED') return 'Development paused';
  if (state === 'OWNER_CHANGES_REQUESTED' || applyingRequestedChanges(p)) return 'Applying requested changes';
  if (state === 'IDEA_SUBMITTED') return 'Starting';
  if (state === 'COUNCIL_DISCOVERY' || state === 'SPECIFICATION_READY' || state === 'COUNCIL_REVIEW') return 'Planning';
  if (state === 'PROJECT_PROVISIONING') return 'Preparing project';
  if (state === 'CURSOR_EXECUTING') return 'Building';
  if (state === 'PLATFORM_VERIFICATION' || state === 'FINAL_VERIFICATION') return 'Verifying';
  if (state === 'RUNTIME_VERIFICATION') return 'Runtime testing';
  if (state === 'VISUAL_VERIFICATION') return 'Visual review';
  if (state === 'DELIVERY_PREPARATION') return 'Preparing delivery';
  return 'Building';
}

function statusBadge(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW') return 'READY';
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') return 'COMPLETE';
  if (p.state === 'FAILED') return 'PAUSED';
  if (p.state === 'OWNER_CHANGES_REQUESTED' || applyingRequestedChanges(p)) return 'UPDATING';
  return 'BUILDING';
}

function isDemoProject(p) {
  return Boolean(p.demo || p.delivery?.demo || p.delivery?.verificationLevel === 'MOCK' || p.verificationLevel === 'MOCK');
}

function productName(p) {
  return p.delivery?.productName || p.council?.discovery?.spec?.productName || p.council?.discovery?.spec?.product?.name || 'New project';
}

function productSummary(p) {
  const spec = p.council?.discovery?.spec || {};
  return p.delivery?.summary
    || spec.productSummary
    || spec.product?.summary
    || 'Autonomous development is in progress.';
}

function deliveryVersion(p) {
  const current = Number(p.delivery?.version);
  if (Number.isFinite(current) && current > 0) return current;
  const versions = (p.deliveries || []).map(item => Number(item.version || 0));
  return Math.max(0, ...versions);
}

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function headerMeta(p) {
  const parts = [];
  const version = deliveryVersion(p);
  if (version) parts.push(`Delivery v${version}`);
  if (isDemoProject(p)) parts.push('Demo');
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') {
    const approved = p.completion?.approvedAt || p.updatedAt;
    parts.push(approved ? `Approved ${formatWhen(approved)}` : formatWhen(p.updatedAt || p.createdAt));
  } else if (p.state === 'READY_FOR_OWNER_REVIEW') {
    parts.push(formatWhen(p.delivery?.readyAt || p.updatedAt || p.createdAt));
  } else {
    parts.push(stageLabel(p));
    parts.push(formatWhen(p.updatedAt || p.createdAt));
  }
  return parts.filter(Boolean).join(' · ');
}

function detailsStorageKey(id) {
  return `adpTechOpen:${id}`;
}

function detailsOpenFor(id) {
  const stored = sessionStorage.getItem(detailsStorageKey(id));
  if (stored === '0') return false;
  if (stored === '1') return true;
  const saved = memory(id);
  if (typeof saved.detailsOpen === 'boolean') return saved.detailsOpen;
  return true;
}

function rememberDetails(id, open) {
  sessionStorage.setItem(detailsStorageKey(id), open ? '1' : '0');
  patchMemory(id, { detailsOpen: open });
}

function sortProjects(list) {
  return [...list].sort((a, b) => {
    const byTime = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    if (byTime) return byTime;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
}

function resolveExpanded(list) {
  const stored = expandedProjectId();
  if (stored && list.some(item => item.id === stored)) return stored;
  const newest = list[0]?.id || '';
  if (newest) setExpandedProjectId(newest);
  return newest;
}

function snapshotUi() {
  const scrollY = window.scrollY;
  for (const card of document.querySelectorAll('.card[data-id]')) {
    const id = card.dataset.id;
    const details = card.querySelector('details.tech');
    const feedback = card.querySelector('.feedback');
    const panel = card.querySelector('.changes-panel');
    const prev = memory(id);
    const feedbackValue = feedback?.value ?? prev.feedback ?? sessionStorage.getItem(draftKey(id)) ?? '';
    patchMemory(id, {
      feedback: feedback?.value ?? prev.feedback ?? sessionStorage.getItem(draftKey(id)) ?? '',
      changesOpen: panel ? !panel.hidden : Boolean(prev.changesOpen),
      detailsOpen: details ? details.open : detailsOpenFor(id)
    });
    if (details) rememberDetails(id, details.open);
  }
  return scrollY;
}

function restoreCard(card, id) {
  const state = memory(id);
  const details = card.querySelector('details.tech');
  if (details) details.open = detailsOpenFor(id);
  const feedback = card.querySelector('.feedback');
  const draft = state.feedback || sessionStorage.getItem(draftKey(id)) || '';
  if (feedback && draft) feedback.value = draft;
  const panel = card.querySelector('.changes-panel');
  if (panel && (state.changesOpen || draft)) panel.hidden = false;
}

function verifyRow(label, card) {
  let value = 'Not applicable';
  if (card?.status === 'DEMO') value = 'Demo';
  else if (card?.status === 'PASS') value = card.label || 'Pass';
  else if (card?.status === 'NOT_APPLICABLE') value = card.label || 'Not applicable';
  else if (card?.label) value = card.label;
  return `<div class="verify-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
}

function deliveryHistory(p) {
  const items = [...(p.deliveries || [])].sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
  if (!items.length) return '';
  const rows = items.map(item => `<div><span>v${esc(item.version)}</span><code>${esc(item.status || '')}</code></div>`).join('');
  return `<h4>Delivery history</h4><div class="tech-grid">${rows}</div>`;
}

function originalRequest(p) {
  const idea = String(p.idea || '').trim();
  if (!idea) return '';
  const long = idea.length > 180;
  const body = `<p class="brief">${esc(idea)}</p>`;
  if (!long) return `<h4>Original request</h4>${body}`;
  return `<details class="brief-details"><summary>Original request</summary>${body}</details>`;
}

function techRows(d, p) {
  const rows = [
    ['State', p.state || 'n/a'],
    ['Checkpoint', d.checkpointSha || 'n/a'],
    ['Delivery', `v${d.version || deliveryVersion(p) || 1}`],
    ['Manifest', d.manifestHash || 'n/a'],
    d.workingBranch ? ['Branch', d.workingBranch] : null,
    ['Project id', p.id]
  ].filter(Boolean);
  return rows.map(([label, value]) => `<div><span>${esc(label)}</span><code>${esc(value)}</code></div>`).join('');
}

function readyCard(p) {
  const d = p.delivery || {};
  const v = d.verification || {};
  const demo = isDemoProject(p);
  const shots = (d.screenshots || []).map(item => `<img alt="${esc(item.fileName || 'screenshot')}" src="/api/projects/${p.id}/artifacts/${item.id}">`).join('');
  const limits = (d.knownLimitations || []).map(item => `<li>${esc(item)}</li>`).join('');
  const tests = (d.testingGuidance || []).map(item => `<li>${esc(item)}</li>`).join('');
  const technical = (d.technicalLimitations || []).filter(item => !(d.knownLimitations || []).includes(item)).map(item => `<li>${esc(item)}</li>`).join('');
  const downloads = (d.artifacts || []).filter(item => item.kind === 'SOURCE_ARCHIVE' || item.kind === 'BUILD')
    .map(item => `<button class="secondary" data-dl="${item.id}">${item.kind === 'BUILD' ? 'Download Build' : 'Download Source'}</button>`).join('');
  const done = p.state === 'DONE' || p.state === 'OWNER_APPROVED';
  const headline = done
    ? 'This project is complete.'
    : (demo ? 'Demo workflow completed' : 'All required automated verification has completed.');
  const explanation = done
    ? 'Approval accepted the autonomous result. It did not deploy or publish anything.'
    : (demo ? 'This delivery demonstrates the complete owner workflow using simulated Council and Cursor execution.' : '');
  const actions = p.state === 'READY_FOR_OWNER_REVIEW'
    ? `<div class="actions">
        <button data-approve="1">Approve</button>
        <button class="secondary" data-changes-open="1">Request Changes</button>
      </div>
      <div class="changes-panel" hidden>
        <label>What would you like changed?</label>
        <textarea class="feedback" placeholder="Describe the change in plain language. You do not need technical instructions."></textarea>
        <div class="actions">
          <button class="secondary" data-changes-cancel="1">Cancel</button>
          <button data-changes="1">Send changes</button>
        </div>
      </div>`
    : '';
  return `
    ${demo ? '<p class="demo-badge">DEMO · MOCK</p>' : ''}
    <p class="summary">${esc(productSummary(p))}</p>
    <p class="headline">${esc(headline)}</p>
    ${explanation ? `<p class="meta">${esc(explanation)}</p>` : ''}
    <div class="actions">
      <button data-open="1">Open App</button>
      ${downloads}
    </div>
    <p class="open-fallback" hidden><a class="review-link" target="_blank" rel="noopener">Open review →</a></p>
    ${shots ? `<div><h4>Screenshots</h4><div class="shots">${shots}</div></div>` : ''}
    <div>
      <h4>Verification</h4>
      <div class="verify-grid">
        ${verifyRow('Build', v.build)}
        ${verifyRow('Automated tests', v.tests)}
        ${verifyRow('Runtime', v.runtime)}
        ${verifyRow('Critical user flows', v.journeys)}
        ${verifyRow('Accessibility', v.accessibility)}
        ${verifyRow('Visual review', v.visual)}
        ${verifyRow('Security', v.security)}
      </div>
    </div>
    <div>
      <h4>Things worth checking</h4>
      <ul class="limits">${tests || '<li>Open the application and confirm it matches what you asked for.</li>'}</ul>
    </div>
    <div>
      <h4>Known limitations</h4>
      <ul class="limits">${limits || '<li>None recorded.</li>'}</ul>
    </div>
    ${techDetails(p, d, technical)}
    ${actions}
  `;
}

function techDetails(p, d, technical = '') {
  return `<details class="tech"${detailsOpenFor(p.id) ? ' open' : ''}>
      <summary>Technical details</summary>
      <div class="tech-grid">${techRows(d, p)}</div>
      ${deliveryHistory(p)}
      ${originalRequest(p)}
      ${technical ? `<h4>Platform notes</h4><ul class="limits">${technical}</ul>` : ''}
    </details>`;
}

function activeCard(p) {
  const d = p.delivery || {};
  const technical = (d.technicalLimitations || []).map(item => `<li>${esc(item)}</li>`).join('');
  if (p.state === 'FAILED') {
    return `<p class="summary">${esc(productSummary(p))}</p><p class="headline">Development paused due to an infrastructure issue.</p><p class="meta">No technical action is required from you unless the operator asks.</p>${techDetails(p, d, technical)}`;
  }
  if (p.state === 'DONE' || p.state === 'OWNER_APPROVED') {
    return readyCard(p);
  }
  if (applyingRequestedChanges(p) || p.state === 'OWNER_CHANGES_REQUESTED') {
    return `<p class="summary">${esc(productSummary(p))}</p><p class="headline">Applying your requested changes</p><p class="meta">Current stage: ${esc(stageLabel(p))}</p><p class="meta">No action required.</p>${techDetails(p, d, technical)}`;
  }
  return `<p class="summary">${esc(productSummary(p))}</p><p class="headline">Building your project</p><p class="meta">Current stage: ${esc(stageLabel(p))}</p><p class="meta">No action required.</p>${techDetails(p, d, technical)}`;
}

function cardBody(p) {
  if (p.state === 'READY_FOR_OWNER_REVIEW' || p.state === 'DONE' || p.state === 'OWNER_APPROVED') return readyCard(p);
  return activeCard(p);
}

function cardHtml(p, expanded) {
  const name = productName(p);
  const bodyId = `project-body-${p.id}`;
  const body = expanded ? `<div class="card-body" id="${bodyId}">${cardBody(p)}</div>` : `<div class="card-body" id="${bodyId}" hidden></div>`;
  return `<article class="card" data-id="${p.id}" data-expanded="${expanded ? '1' : '0'}" id="project-${p.id}">
    <button type="button" class="card-toggle" data-expand="1" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${bodyId}">
      <span class="card-head-main">
        <span class="card-title">${esc(name)}</span>
        <span class="card-meta">${esc(headerMeta(p))}</span>
      </span>
      <span class="status ${statusClass(p)}">${esc(statusBadge(p))}</span>
      <span class="chevron" aria-hidden="true"></span>
    </button>
    ${body}
  </article>`;
}

function renderProjects(list) {
  lastProjects = sortProjects(list);
  const countEl = $('#project-count');
  if (countEl) {
    const n = lastProjects.length;
    countEl.textContent = n === 0 ? '' : n === 1 ? '1 project' : `${n} projects`;
  }
  if (!lastProjects.length) {
    projects.innerHTML = '<p>No projects yet.</p>';
    return;
  }
  const expanded = resolveExpanded(lastProjects);
  projects.innerHTML = lastProjects.map(item => cardHtml(item, item.id === expanded)).join('');
  for (const card of document.querySelectorAll('.card[data-id]')) restoreCard(card, card.dataset.id);
}

function expandProject(id, { focus = false } = {}) {
  if (!id || id === expandedProjectId()) {
    if (focus) pendingFocusId = id;
    return;
  }
  snapshotUi();
  setExpandedProjectId(id);
  if (focus) pendingFocusId = id;
  renderProjects(lastProjects);
  finishRender();
}

function finishRender(scrollY) {
  if (pendingFocusId) {
    const card = document.querySelector(`.card[data-id="${CSS.escape(pendingFocusId)}"]`);
    const toggle = card?.querySelector('.card-toggle');
    if (card) {
      const rect = card.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > window.innerHeight - 24) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      toggle?.focus({ preventScroll: true });
    }
    pendingFocusId = null;
    return;
  }
  if (typeof scrollY === 'number') window.scrollTo(0, scrollY);
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showError(message, detail) {
  const error = $('#error');
  error.textContent = message;
  if (detail && detail !== message) error.textContent = `${message} ${detail}`;
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
    inbox.innerHTML = unread.map(item => `<p><strong>${esc(item.title)}</strong> <a href="#project-${item.projectId}" data-read="${item.id}" data-project="${item.projectId}">Open review</a></p>`).join('');
  } catch {
    inbox.hidden = true;
  }
}

async function load({ quiet } = {}) {
  if (!quiet) $('#error').textContent = '';
  try {
    const list = await api('/api/projects');
    if (!Array.isArray(list)) {
      projects.innerHTML = '<p>Authentication required.</p>';
      return;
    }
    await loadInbox();
    const scrollY = snapshotUi();
    renderProjects(list);
    finishRender(scrollY);
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
    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea, projectPath: $('#path').value.trim() || null })
    });
    $('#idea').value = '';
    if (created?.id) {
      setExpandedProjectId(created.id);
      pendingFocusId = created.id;
    }
    await load();
  } catch (error) {
    showError(error.message);
  }
};

$('#refresh').onclick = () => load();

projects.addEventListener('toggle', event => {
  const details = event.target.closest('details.tech');
  const card = event.target.closest('.card');
  if (!details || !card) return;
  rememberDetails(card.dataset.id, details.open);
}, true);

projects.addEventListener('input', event => {
  if (!event.target.classList.contains('feedback')) return;
  const card = event.target.closest('.card');
  if (!card) return;
  patchMemory(card.dataset.id, { feedback: event.target.value, changesOpen: true });
});

projects.addEventListener('click', async event => {
  const toggle = event.target.closest('[data-expand]');
  if (toggle) {
    const card = toggle.closest('.card');
    if (card?.dataset.id) expandProject(card.dataset.id, { focus: false });
    const next = document.querySelector(`.card[data-id="${CSS.escape(card.dataset.id)}"]`);
    if (next) {
      const rect = next.getBoundingClientRect();
      if (rect.top < 80 || rect.bottom > window.innerHeight - 24) next.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  const card = event.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  try {
    if (event.target.dataset.open) {
      const fallback = card.querySelector('.open-fallback');
      const link = card.querySelector('.review-link');
      const tab = window.open('about:blank', '_blank');
      try {
        const session = await api(`/api/projects/${id}/review-session`, { method: 'POST' });
        const url = session.url || session.reviewUrl;
        if (!url) throw new Error('Review URL was not returned.');
        if (tab) tab.location = url;
        else {
          if (fallback && link) {
            link.href = url;
            fallback.hidden = false;
          }
          showError('Unable to open the review application. Use Open review →');
        }
      } catch (error) {
        try { if (tab) tab.close(); } catch {}
        showError('Unable to open the review application. Please try again.', error.message);
      }
    }
    if (event.target.dataset.changesOpen) {
      const panel = card.querySelector('.changes-panel');
      if (panel) panel.hidden = false;
      patchMemory(id, { changesOpen: true });
      card.querySelector('.feedback')?.focus();
    }
    if (event.target.dataset.changesCancel) {
      const panel = card.querySelector('.changes-panel');
      if (panel) panel.hidden = true;
      patchMemory(id, { changesOpen: false });
    }
    if (event.target.dataset.approve) {
      await api(`/api/projects/${id}/approve`, { method: 'POST' });
      await load();
    }
    if (event.target.dataset.changes) {
      const feedback = card.querySelector('.feedback')?.value.trim();
      if (!feedback) return showError('Add a short description of the change.');
      await api(`/api/projects/${id}/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback })
      });
      patchMemory(id, { feedback: '', changesOpen: false });
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
    showError(error.message);
  }
});

inbox.addEventListener('click', async event => {
  const link = event.target.closest('[data-project],[data-read]');
  if (!link) return;
  const projectId = link.dataset.project;
  if (projectId) {
    event.preventDefault();
    expandProject(projectId, { focus: true });
  }
  const id = link.dataset.read;
  if (!id) return;
  try { await api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
  await loadInbox();
});

load();
setInterval(() => load({ quiet: true }), POLL_MS);
