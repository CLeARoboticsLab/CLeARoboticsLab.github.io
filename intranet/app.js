// ============================================================
// State
// ============================================================
const STATE = {
  user: null,
  profile: null,        // current user's profiles row
  profiles: [],          // all profiles, for owner names + filter dropdown
  templates: [],          // stage_templates with .items
  projects: [],            // projects with .project_stages and .stage_history
  newStageEditor: [],       // working list while creating a project: [{name, target_date}]
  openProjectId: null,
};

const WEEK_MS = 7 * 24 * 3600 * 1000;

// ============================================================
// Boot
// ============================================================
(async function init() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'auth.html'; return; }
  STATE.user = session.user;

  await loadAll();
  wireEvents();
  renderAll();
})();

async function loadAll() {
  const [{ data: profiles }, { data: templates }, { data: templateItems }, { data: projects }] = await Promise.all([
    supabaseClient.from('profiles').select('*').order('full_name'),
    supabaseClient.from('stage_templates').select('*').order('name'),
    supabaseClient.from('stage_template_items').select('*').order('sort_order'),
    supabaseClient.from('projects').select(`
      *,
      owner:profiles(id, full_name, role),
      project_stages(*),
      stage_history(*)
    `).order('created_at', { ascending: false }),
  ]);

  STATE.profiles = profiles || [];
  STATE.profile = STATE.profiles.find(p => p.id === STATE.user.id) || null;
  STATE.templates = (templates || []).map(t => ({
    ...t,
    items: (templateItems || []).filter(i => i.template_id === t.id).sort((a, b) => a.sort_order - b.sort_order),
  }));
  STATE.projects = (projects || []).map(p => ({
    ...p,
    project_stages: (p.project_stages || []).sort((a, b) => a.sort_order - b.sort_order),
    stage_history: (p.stage_history || []).sort((a, b) => new Date(a.entered_at) - new Date(b.entered_at)),
  }));
}

function isPI() { return STATE.profile && STATE.profile.role === 'pi'; }
function canEdit(project) { return isPI() || project.owner_id === STATE.user.id; }

// ============================================================
// Derived per-project values
// ============================================================
function computeDerived(project) {
  const stages = project.project_stages;
  const history = project.stage_history;
  const current = history.find(h => !h.exited_at) || history[history.length - 1] || null;
  const currentIndex = current ? stages.findIndex(s => s.name === current.stage_name) : -1;
  const now = new Date();
  const ageWeeks = (now - new Date(project.created_at)) / WEEK_MS;
  const stageWeeks = current ? (now - new Date(current.entered_at)) / WEEK_MS : 0;

  // Staleness is based on the current stage's target_date if set;
  // red = overdue, amber = due within 7 days, green = on track or no date set
  const currentStage = currentIndex >= 0 ? stages[currentIndex] : null;
  const targetDate = currentStage && currentStage.target_date ? new Date(currentStage.target_date) : null;
  let staleLevel = 'green';
  if (targetDate) {
    const daysUntil = (targetDate - now) / (1000 * 3600 * 24);
    if (daysUntil < 0) staleLevel = 'red';
    else if (daysUntil < 7) staleLevel = 'amber';
  }

  return {
    stages, history, current, currentIndex,
    totalStages: stages.length,
    remaining: Math.max(stages.length - 1 - currentIndex, 0),
    ageWeeks, stageWeeks, targetDate, staleLevel,
  };
}

function fmtWeeks(w) {
  if (w < 1.5) return Math.round(w * 7) + 'd';
  return Math.round(w) + 'wk';
}
function fmtAge(weeks) {
  if (weeks < 8) return Math.round(weeks) + ' wk active';
  return (Math.round(weeks / 4.345 * 10) / 10) + ' mo active';
}
function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

// ============================================================
// Render: top bar, stats, filters
// ============================================================
function renderAll() {
  document.getElementById('whoami').textContent =
    `${STATE.profile ? STATE.profile.full_name : ''} · ${isPI() ? 'PI view' : 'your lab'}`;
  document.getElementById('np-owner-field').style.display = isPI() ? 'block' : 'none';

  renderFilterOptions();
  renderStats();
  renderProjectList();
}

function renderFilterOptions() {
  const ownerSel = document.getElementById('filter-owner');
  if (ownerSel.options.length <= 1) {
    STATE.profiles.filter(p => p.role !== 'pi').forEach(p => {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.full_name;
      ownerSel.appendChild(o);
    });
  }
  const npOwner = document.getElementById('np-owner');
  if (npOwner.options.length === 0) {
    STATE.profiles.forEach(p => {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.full_name;
      if (p.id === STATE.user.id) o.selected = true;
      npOwner.appendChild(o);
    });
  }
  const stageSel = document.getElementById('filter-stage');
  if (stageSel.options.length <= 1) {
    const names = new Set();
    STATE.templates.forEach(t => t.items.forEach(i => names.add(i.name)));
    [...names].forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; stageSel.appendChild(o); });
  }
  const npTemplate = document.getElementById('np-template');
  if (npTemplate.options.length === 0) {
    STATE.templates.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; npTemplate.appendChild(o); });
  }
}

function renderStats() {
  const active = STATE.projects.filter(p => p.status === 'active');
  const staleCount = active.filter(p => computeDerived(p).staleLevel === 'red').length;
  const trainees = STATE.profiles.filter(p => p.role !== 'pi').length;
  document.getElementById('stat-row').innerHTML = `
    <div class="stat"><div class="n">${active.length}</div><div class="l">active projects</div></div>
    <div class="stat"><div class="n">${trainees}</div><div class="l">trainees</div></div>
    <div class="stat"><div class="n">${staleCount}</div><div class="l">stale (red)</div></div>
  `;
}

// ============================================================
// Render: project list
// ============================================================
function renderProjectList() {
  const ownerFilter = document.getElementById('filter-owner').value;
  const stageFilter = document.getElementById('filter-stage').value;
  const showArchived = document.getElementById('filter-archived').checked;
  const sortBy = document.getElementById('sort-by').value;

  let rows = STATE.projects.filter(p => showArchived ? true : p.status === 'active');
  if (ownerFilter) rows = rows.filter(p => p.owner_id === ownerFilter);
  if (stageFilter) rows = rows.filter(p => { const d = computeDerived(p); return d.current && d.current.stage_name === stageFilter; });

  const withDerived = rows.map(p => ({ p, d: computeDerived(p) }));
  withDerived.sort((a, b) => {
    if (sortBy === 'stage_time') return b.d.stageWeeks - a.d.stageWeeks;
    if (sortBy === 'age') return b.d.ageWeeks - a.d.ageWeeks;
    if (sortBy === 'title') return a.p.title.localeCompare(b.p.title);
    if (sortBy === 'deadline') {
      if (!a.p.target_deadline) return 1;
      if (!b.p.target_deadline) return -1;
      return new Date(a.p.target_deadline) - new Date(b.p.target_deadline);
    }
    return 0;
  });

  const list = document.getElementById('project-list');
  document.getElementById('empty-state').style.display = withDerived.length ? 'none' : 'block';
  list.innerHTML = withDerived.map(({ p, d }) => renderProjectRow(p, d)).join('');
  list.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => openProjectModal(el.getAttribute('data-open')));
  });
}

function renderProjectRow(project, d) {
  const owner = project.owner || {};
  const stageLabel = d.current ? d.current.stage_name : '—';
  const dots = d.stages.map((s, i) => {
    const cls = i === d.currentIndex ? 'dot current' : (i < d.currentIndex ? 'dot filled' : 'dot');
    return `<span class="${cls}"></span>`;
  }).join('');
  const timingLabel = d.targetDate
    ? (d.staleLevel === 'red'
        ? `due ${fmtDate(d.targetDate.toISOString())}`
        : `by ${fmtDate(d.targetDate.toISOString())}`)
    : fmtWeeks(d.stageWeeks) + ' in stage';
  return `
    <div class="proj-row stale-${d.staleLevel}" data-open="${project.id}">
      <div class="avatar">${initials(owner.full_name)}</div>
      <div class="proj-main">
        <div class="proj-title">${escapeHtml(project.title)}</div>
        <div class="proj-meta">${escapeHtml(owner.full_name || '')}${owner.role ? ' · ' + owner.role : ''}${project.collaborators ? ' · w/ ' + escapeHtml(project.collaborators) : ''}</div>
      </div>
      <span class="badge">${escapeHtml(stageLabel)}</span>
      <div class="dots">${dots}</div>
      <div class="timing">
        <div class="stage-time">${timingLabel}</div>
        <div class="age">${fmtAge(d.ageWeeks)}</div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// New project modal
// ============================================================
function loadTemplateIntoEditor(templateId) {
  const t = STATE.templates.find(t => t.id === templateId);
  if (t) {
    let offsetDays = 0;
    STATE.newStageEditor = t.items.map(i => {
      offsetDays += (i.stale_after_weeks || 3) * 7;
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      return { name: i.name, target_date: d.toISOString().slice(0, 10) };
    });
  } else {
    STATE.newStageEditor = [];
  }
  renderStageEditor();
}

function renderStageEditor() {
  const box = document.getElementById('np-stage-editor');
  box.innerHTML = STATE.newStageEditor.map((s, i) => `
    <div class="stage-editor-row">
      <input type="text" value="${escapeHtml(s.name)}" data-idx="${i}" class="se-name" placeholder="Stage name">
      <input type="date" value="${s.target_date || ''}" data-idx="${i}" class="se-date" style="width:160px;" title="Target completion date">
      <div class="order-btns">
        <button type="button" data-idx="${i}" data-dir="-1" class="se-move">▲</button>
        <button type="button" data-idx="${i}" data-dir="1" class="se-move">▼</button>
      </div>
      <button type="button" data-idx="${i}" class="se-remove subtle">✕</button>
    </div>`).join('');

  box.querySelectorAll('.se-name').forEach(el => el.addEventListener('input', e => {
    STATE.newStageEditor[+e.target.dataset.idx].name = e.target.value;
  }));
  box.querySelectorAll('.se-date').forEach(el => el.addEventListener('input', e => {
    STATE.newStageEditor[+e.target.dataset.idx].target_date = e.target.value || null;
  }));
  box.querySelectorAll('.se-remove').forEach(el => el.addEventListener('click', e => {
    STATE.newStageEditor.splice(+e.target.dataset.idx, 1); renderStageEditor();
  }));
  box.querySelectorAll('.se-move').forEach(el => el.addEventListener('click', e => {
    const i = +e.target.dataset.idx, dir = +e.target.dataset.dir, j = i + dir;
    if (j < 0 || j >= STATE.newStageEditor.length) return;
    [STATE.newStageEditor[i], STATE.newStageEditor[j]] = [STATE.newStageEditor[j], STATE.newStageEditor[i]];
    renderStageEditor();
  }));
}

async function submitNewProject(e) {
  e.preventDefault();
  const msg = document.getElementById('new-msg');
  msg.innerHTML = '';
  if (STATE.newStageEditor.length === 0) {
    msg.innerHTML = '<div class="msg error">Add at least one stage.</div>'; return;
  }
  const title = document.getElementById('np-title').value.trim();
  const owner_id = isPI() ? document.getElementById('np-owner').value : STATE.user.id;
  const template_id = document.getElementById('np-template').value || null;
  const target_venue = document.getElementById('np-venue').value || null;
  const target_deadline = document.getElementById('np-deadline').value || null;
  const collaborators = document.getElementById('np-collab').value || null;

  const { data: proj, error: e1 } = await supabaseClient.from('projects')
    .insert([{ title, owner_id, template_id, target_venue, target_deadline, collaborators }])
    .select().single();
  if (e1) { msg.innerHTML = `<div class="msg error">${e1.message}</div>`; return; }

  const stageRows = STATE.newStageEditor.map((s, i) => ({
    project_id: proj.id, name: s.name, sort_order: i + 1, target_date: s.target_date || null,
  }));
  const { error: e2 } = await supabaseClient.from('project_stages').insert(stageRows);
  if (e2) { msg.innerHTML = `<div class="msg error">${e2.message}</div>`; return; }

  const { error: e3 } = await supabaseClient.from('stage_history')
    .insert([{ project_id: proj.id, stage_name: STATE.newStageEditor[0].name }]);
  if (e3) { msg.innerHTML = `<div class="msg error">${e3.message}</div>`; return; }

  closeModal('modal-new');
  document.getElementById('form-new-project').reset();
  await loadAll();
  renderAll();
}

// ============================================================
// Project detail modal
// ============================================================
function openProjectModal(id) {
  STATE.openProjectId = id;
  const project = STATE.projects.find(p => p.id === id);
  const d = computeDerived(project);
  const editable = canEdit(project);

  document.getElementById('pd-title').textContent = project.title;
  document.getElementById('pd-dots').innerHTML = d.stages.map((s, i) => {
    const cls = i === d.currentIndex ? 'dot current' : (i < d.currentIndex ? 'dot filled' : 'dot');
    return `<span class="${cls}" title="${escapeHtml(s.name)}"></span>`;
  }).join('');
  document.getElementById('pd-stage-label').textContent =
    `${d.current ? d.current.stage_name : '—'} · ${fmtWeeks(d.stageWeeks)} in stage · ${d.remaining} stage(s) remaining · ${fmtAge(d.ageWeeks)}`;

  // Stage target dates editor
  const stageDatesDiv = document.getElementById('pd-stage-dates');
  stageDatesDiv.innerHTML = d.stages.map(s => `
    <div class="stage-editor-row" style="margin-bottom:5px;">
      <span style="flex:1; font-size:13px; color:var(--text);">${escapeHtml(s.name)}</span>
      <input type="date" value="${s.target_date || ''}" data-stage-id="${s.id}"
        class="pd-stage-date" style="width:160px;" ${editable ? '' : 'disabled'}>
    </div>`).join('');

  document.getElementById('pd-venue').value = project.target_venue || '';
  document.getElementById('pd-deadline').value = project.target_deadline || '';
  document.getElementById('pd-collab').value = project.collaborators || '';
  document.getElementById('pd-notes').value = project.notes || '';
  ['pd-venue', 'pd-deadline', 'pd-collab', 'pd-notes'].forEach(fid => document.getElementById(fid).disabled = !editable);
  document.getElementById('pd-save').style.display = editable ? 'inline-block' : 'none';

  document.getElementById('pd-back').style.display = (editable && d.currentIndex > 0) ? 'inline-block' : 'none';
  document.getElementById('pd-advance').style.display = editable ? 'inline-block' : 'none';
  document.getElementById('pd-advance').textContent = (d.currentIndex === d.stages.length - 1) ? 'Mark complete & archive' : 'Advance ▸';

  const archiveBtn = document.getElementById('pd-archive');
  archiveBtn.style.display = editable ? 'inline-block' : 'none';
  archiveBtn.textContent = project.status === 'archived' ? 'Re-activate' : 'Archive';
  document.getElementById('pd-delete').style.display = editable ? 'inline-block' : 'none';

  document.getElementById('pd-history').innerHTML = d.history
    .slice().reverse()
    .map(h => `<li><span>${escapeHtml(h.stage_name)}</span><span class="hl-meta">${fmtDate(h.entered_at)} → ${h.exited_at ? fmtDate(h.exited_at) : 'current'}</span></li>`)
    .join('');

  document.getElementById('pd-msg').innerHTML = '';
  openModal('modal-detail');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function savePdDetails() {
  const project = STATE.projects.find(p => p.id === STATE.openProjectId);
  const updates = {
    target_venue: document.getElementById('pd-venue').value || null,
    target_deadline: document.getElementById('pd-deadline').value || null,
    collaborators: document.getElementById('pd-collab').value || null,
    notes: document.getElementById('pd-notes').value || null,
  };
  const { error } = await supabaseClient.from('projects').update(updates).eq('id', project.id);

  // Save each stage's target date
  const dateInputs = document.querySelectorAll('.pd-stage-date');
  for (const input of dateInputs) {
    await supabaseClient.from('project_stages')
      .update({ target_date: input.value || null })
      .eq('id', input.dataset.stageId);
  }

  const msg = document.getElementById('pd-msg');
  msg.innerHTML = error ? `<div class="msg error">${error.message}</div>` : `<div class="msg ok">Saved.</div>`;
  await loadAll(); renderAll();
}

async function advanceStage() {
  const project = STATE.projects.find(p => p.id === STATE.openProjectId);
  const d = computeDerived(project);
  if (!d.current) return;

  if (d.currentIndex === d.stages.length - 1) {
    if (!confirm('Mark this project complete and archive it?')) return;
    await supabaseClient.from('stage_history').update({ exited_at: new Date().toISOString() }).eq('id', d.current.id);
    await supabaseClient.from('projects').update({ status: 'archived' }).eq('id', project.id);
  } else {
    const next = d.stages[d.currentIndex + 1];
    await supabaseClient.from('stage_history').update({ exited_at: new Date().toISOString() }).eq('id', d.current.id);
    await supabaseClient.from('stage_history').insert([{ project_id: project.id, stage_name: next.name }]);
  }
  await loadAll(); renderAll(); openProjectModal(project.id);
}

async function moveBack() {
  const project = STATE.projects.find(p => p.id === STATE.openProjectId);
  const d = computeDerived(project);
  if (d.currentIndex <= 0) return;
  const prevStageName = d.stages[d.currentIndex - 1].name;
  const prevHistory = [...d.history].reverse().find(h => h.stage_name === prevStageName && h.exited_at);
  if (!confirm(`Move this project back to "${prevStageName}"?`)) return;

  // delete the (mistaken) current open entry, reopen the previous one
  await supabaseClient.from('stage_history').delete().eq('id', d.current.id);
  if (prevHistory) {
    await supabaseClient.from('stage_history').update({ exited_at: null }).eq('id', prevHistory.id);
  } else {
    await supabaseClient.from('stage_history').insert([{ project_id: project.id, stage_name: prevStageName }]);
  }
  await loadAll(); renderAll(); openProjectModal(project.id);
}

async function toggleArchive() {
  const project = STATE.projects.find(p => p.id === STATE.openProjectId);
  const newStatus = project.status === 'archived' ? 'active' : 'archived';
  await supabaseClient.from('projects').update({ status: newStatus }).eq('id', project.id);
  await loadAll(); renderAll(); openProjectModal(project.id);
}

async function deleteProject() {
  const project = STATE.projects.find(p => p.id === STATE.openProjectId);
  if (!confirm(`Delete "${project.title}"? This can't be undone.`)) return;
  await supabaseClient.from('projects').delete().eq('id', project.id);
  closeModal('modal-detail');
  await loadAll(); renderAll();
}

// ============================================================
// Modal plumbing + event wiring
// ============================================================
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function wireEvents() {
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'auth.html';
  });

  document.getElementById('btn-new-project').addEventListener('click', () => {
    document.getElementById('form-new-project').reset();
    STATE.newStageEditor = [];
    if (document.getElementById('np-template').value) loadTemplateIntoEditor(document.getElementById('np-template').value);
    renderStageEditor();
    document.getElementById('new-msg').innerHTML = '';
    openModal('modal-new');
  });
  document.getElementById('np-template').addEventListener('change', e => loadTemplateIntoEditor(e.target.value));
  document.getElementById('np-add-stage').addEventListener('click', () => {
    STATE.newStageEditor.push({ name: 'New stage', target_date: null });
    renderStageEditor();
  });
  document.getElementById('form-new-project').addEventListener('submit', submitNewProject);

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', e => { if (e.target === bd) closeModal(bd.id); });
  });

  document.getElementById('filter-owner').addEventListener('change', renderProjectList);
  document.getElementById('filter-stage').addEventListener('change', renderProjectList);
  document.getElementById('filter-archived').addEventListener('change', renderProjectList);
  document.getElementById('sort-by').addEventListener('change', renderProjectList);

  document.getElementById('pd-save').addEventListener('click', savePdDetails);
  document.getElementById('pd-advance').addEventListener('click', advanceStage);
  document.getElementById('pd-back').addEventListener('click', moveBack);
  document.getElementById('pd-archive').addEventListener('click', toggleArchive);
  document.getElementById('pd-delete').addEventListener('click', deleteProject);
}
