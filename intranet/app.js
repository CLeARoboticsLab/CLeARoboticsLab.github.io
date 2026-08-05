// ============================================================
// State
// ============================================================
const STATE = {
  user: null,
  profile: null,
  profiles: [],
  templates: [],
  projects: [],
  collaboratorProjectIds: new Set(), // project IDs where current user is a collaborator (not owner)
  newStageEditor: [],
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
  // Fetch profiles first — needed to determine role before scoping other queries
  const { data: profiles } = await supabaseClient.from('profiles').select('*').order('full_name');
  STATE.profiles = profiles || [];
  STATE.profile = STATE.profiles.find(p => p.id === STATE.user.id) || null;

  const [{ data: templates }, { data: templateItems }, { data: projects }, { data: myCollabs }, { data: allCollabs }] = await Promise.all([
    supabaseClient.from('stage_templates').select('*').order('name'),
    supabaseClient.from('stage_template_items').select('*').order('sort_order'),
    supabaseClient.from('projects').select(`
      *,
      owner:owner_id(id, full_name, role),
      project_stages(*),
      stage_history(*)
    `).order('created_at', { ascending: false }),
    // Project IDs where current user is a collaborator
    supabaseClient.from('project_collaborators').select('project_id').eq('profile_id', STATE.user.id),
    // All collaborator memberships (to attach to projects)
    supabaseClient.from('project_collaborators').select('project_id, profile_id'),
  ]);

  STATE.collaboratorProjectIds = new Set((myCollabs || []).map(r => r.project_id));

  STATE.templates = (templates || []).map(t => ({
    ...t,
    items: (templateItems || []).filter(i => i.template_id === t.id).sort((a, b) => a.sort_order - b.sort_order),
  }));
  STATE.projects = (projects || []).map(p => ({
    ...p,
    project_stages: (p.project_stages || []).sort((a, b) => a.sort_order - b.sort_order),
    stage_history: (p.stage_history || []).sort((a, b) => new Date(a.entered_at) - new Date(b.entered_at)),
    internal_collaborator_ids: (allCollabs || []).filter(c => c.project_id === p.id).map(c => c.profile_id),
  }));
}

function isPI() { return STATE.profile && STATE.profile.role === 'pi'; }
function isCollaborator(project) { return STATE.collaboratorProjectIds.has(project.id); }
// canEdit: can advance stages and edit notes/dates — owner, PI, or collaborator
function canEdit(project) { return isPI() || project.owner_id === STATE.user.id || isCollaborator(project); }
// canManage: can rename/delete stages, add collaborators, archive, delete — owner or PI only
function canManage(project) { return isPI() || project.owner_id === STATE.user.id; }

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
    `${STATE.profile ? STATE.profile.full_name : ''} · ${isPI() ? 'PI view' : 'your projects'}`;
  document.getElementById('np-owner-field').style.display = isPI() ? 'block' : 'none';
  document.getElementById('filter-owner').closest('select').style.display = isPI() ? 'inline-block' : 'none';

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
  const npCollabs = document.getElementById('np-internal-collabs');
  if (npCollabs.children.length === 0) {
    const others = STATE.profiles.filter(p => p.role !== 'pi' && p.id !== STATE.user.id);
    if (others.length === 0) {
      npCollabs.innerHTML = '<span style="font-size:13px;color:var(--text-faint);">No other lab members yet.</span>';
    } else {
      others.forEach(p => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;';
        label.innerHTML = `<input type="checkbox" value="${p.id}" class="np-collab-check" style="width:auto;"> ${escapeHtml(p.full_name)}`;
        npCollabs.appendChild(label);
      });
    }
  }
  const npTemplate = document.getElementById('np-template');
  if (npTemplate.options.length === 0) {
    STATE.templates.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; npTemplate.appendChild(o); });
  }
}

function renderStats() {
  const visibleActive = STATE.projects.filter(p => {
    if (p.status !== 'active') return false;
    if (isPI()) return true;
    return p.owner_id === STATE.user.id || STATE.collaboratorProjectIds.has(p.id);
  });
  const staleCount = visibleActive.filter(p => computeDerived(p).staleLevel === 'red').length;
  if (isPI()) {
    const trainees = STATE.profiles.filter(p => p.role !== 'pi').length;
    document.getElementById('stat-row').innerHTML = `
      <div class="stat"><div class="n">${visibleActive.length}</div><div class="l">active projects</div></div>
      <div class="stat"><div class="n">${trainees}</div><div class="l">trainees</div></div>
      <div class="stat"><div class="n">${staleCount}</div><div class="l">stale (red)</div></div>`;
  } else {
    document.getElementById('stat-row').innerHTML = `
      <div class="stat"><div class="n">${visibleActive.length}</div><div class="l">active projects</div></div>
      <div class="stat"><div class="n">${staleCount}</div><div class="l">overdue</div></div>`;
  }
}

// ============================================================
// Render: project list
// ============================================================
function renderProjectList() {
  const ownerFilter = document.getElementById('filter-owner').value;
  const stageFilter = document.getElementById('filter-stage').value;
  const showArchived = document.getElementById('filter-archived').checked;
  const sortBy = document.getElementById('sort-by').value;
  // Whose board are we centring on? A PI's trainee-filter selection, or a
  // trainee viewing their own projects. Projects they lead (own) sort ahead of
  // ones they only collaborate on.
  const focusUid = ownerFilter || (!isPI() ? STATE.user.id : '');

  let rows = STATE.projects.filter(p => {
    if (!showArchived && p.status !== 'active') return false;
    // Non-PI users only see projects they own or collaborate on
    if (!isPI() && p.owner_id !== STATE.user.id && !STATE.collaboratorProjectIds.has(p.id)) return false;
    return true;
  });
  // Filtering by a trainee shows projects they own AND those they collaborate on.
  if (ownerFilter) rows = rows.filter(p =>
    p.owner_id === ownerFilter || (p.internal_collaborator_ids || []).includes(ownerFilter));
  if (stageFilter) rows = rows.filter(p => { const d = computeDerived(p); return d.current && d.current.stage_name === stageFilter; });

  const withDerived = rows.map(p => ({ p, d: computeDerived(p) }));
  withDerived.sort((a, b) => {
    // Lead (owned) projects first, then collaborations, then the chosen sort within each group.
    if (focusUid) {
      const aLeads = a.p.owner_id === focusUid ? 0 : 1;
      const bLeads = b.p.owner_id === focusUid ? 0 : 1;
      if (aLeads !== bLeads) return aLeads - bLeads;
    }
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
  const timingLabel = d.targetDate
    ? (d.staleLevel === 'red'
        ? `due ${fmtDate(d.targetDate.toISOString())}`
        : `by ${fmtDate(d.targetDate.toISOString())}`)
    : fmtWeeks(d.stageWeeks) + ' in stage';

  // Internal collaborator names
  const collabNames = (project.internal_collaborator_ids || [])
    .map(id => STATE.profiles.find(p => p.id === id)?.full_name)
    .filter(Boolean);
  const collabStr = collabNames.length ? ' · w/ ' + collabNames.join(', ') : (project.collaborators ? ' · w/ ' + project.collaborators : '');

  // Stage pipeline
  const stages = d.stages;
  const ci = d.currentIndex;
  // Show every stage for typical projects; for long pipelines, window around the
  // current stage — a little history for context plus several upcoming stages.
  // (The pillbox wraps, so extra pills fill otherwise-empty horizontal space.)
  const MAX_INLINE = 8;
  let pipelineHtml = '';
  if (stages.length <= MAX_INLINE) {
    pipelineHtml = stages.map((s, i) => stagePill(s.name, i, ci)).join(arrow());
  } else if (ci < 0) {
    // Current stage couldn't be matched (e.g. a name mismatch between
    // stage_history and project_stages). Show the first several rather than
    // indexing out of bounds, which would throw and blank the list.
    pipelineHtml = stages.slice(0, 6).map((s, i) => stagePill(s.name, i, ci)).join(arrow())
      + arrow() + ellipsis();
  } else {
    const start = Math.max(0, ci - 2);
    const end = Math.min(stages.length - 1, ci + 4);
    const parts = [];
    if (start > 0) parts.push(ellipsis());
    for (let i = start; i <= end; i++) parts.push(stagePill(stages[i].name, i, ci));
    if (end < stages.length - 1) parts.push(ellipsis());
    pipelineHtml = parts.join(arrow());
  }

  return `
    <div class="proj-row stale-${d.staleLevel}" data-open="${project.id}">
      <div class="avatar">${initials(owner.full_name)}</div>
      <div class="proj-main">
        <div class="proj-title">${escapeHtml(project.title)}</div>
        <div class="proj-meta">${escapeHtml(owner.full_name || '')}${owner.role ? ' · ' + owner.role : ''}${escapeHtml(collabStr)}</div>
        <div class="stage-pipeline">${pipelineHtml}</div>
      </div>
      <div class="timing">
        <div class="stage-time">${timingLabel}</div>
        <div class="age">${fmtAge(d.ageWeeks)}</div>
      </div>
    </div>`;
}

function stagePill(name, index, currentIndex) {
  if (index < currentIndex) {
    return `<span class="stage-pill done">${escapeHtml(name)}</span>`;
  } else if (index === currentIndex) {
    return `<span class="stage-pill current">${escapeHtml(name)}</span>`;
  } else {
    return `<span class="stage-pill future">${escapeHtml(name)}</span>`;
  }
}

function arrow() {
  return `<span style="font-size:10px;color:var(--text-faint);align-self:center;flex-shrink:0;">›</span>`;
}

function ellipsis() {
  return `<span style="font-size:11px;color:var(--text-faint);align-self:center;">…</span>`;
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
    <div class="stage-editor-row" data-idx="${i}">
      <span class="se-drag" draggable="true" data-idx="${i}" title="Drag to reorder"
        style="cursor:grab;user-select:none;color:var(--text-faint);padding:0 2px;">⠿</span>
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

  // Drag-to-reorder via the grip handle (complements the ▲▼ buttons).
  let dragFrom = null;
  box.querySelectorAll('.se-drag').forEach(handle => {
    handle.addEventListener('dragstart', e => {
      dragFrom = +handle.dataset.idx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFrom)); // Firefox requires data
      handle.closest('.stage-editor-row').style.opacity = '0.4';
    });
    handle.addEventListener('dragend', () => {
      const row = handle.closest('.stage-editor-row');
      if (row) row.style.opacity = '';
    });
  });
  box.querySelectorAll('.stage-editor-row').forEach(row => {
    row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const to = +row.dataset.idx;
      const from = dragFrom;
      dragFrom = null;
      if (from === null || Number.isNaN(to) || from === to) return;
      const arr = STATE.newStageEditor;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      renderStageEditor();
    });
  });
}

// True if any dated stage falls before a stage earlier in the sequence
// (nulls/blank dates are skipped). Used to block out-of-order saves.
function datesOutOfOrder(dates) {
  let last = null;
  for (const ds of dates) {
    if (!ds) continue;
    const d = new Date(ds);
    if (last && d < last) return true;
    last = d;
  }
  return false;
}

async function submitNewProject(e) {
  e.preventDefault();
  const msg = document.getElementById('new-msg');
  msg.innerHTML = '';
  if (STATE.newStageEditor.length === 0) {
    msg.innerHTML = '<div class="msg error">Add at least one stage.</div>'; return;
  }
  if (datesOutOfOrder(STATE.newStageEditor.map(s => s.target_date))) {
    msg.innerHTML = "<div class=\"msg error\">Changes not saved — stage target dates aren't in chronological order.</div>"; return;
  }
  const title = document.getElementById('np-title').value.trim();
  const owner_id = isPI() ? document.getElementById('np-owner').value : STATE.user.id;
  const template_id = document.getElementById('np-template').value || null;
  const target_venue = document.getElementById('np-venue').value || null;
  const target_deadline = document.getElementById('np-deadline').value || null;
  const collaborators = document.getElementById('np-collab').value || null;
  const internalCollabIds = [...document.querySelectorAll('.np-collab-check:checked')].map(cb => cb.value);

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

  if (internalCollabIds.length > 0) {
    const { error: e4 } = await supabaseClient.from('project_collaborators')
      .insert(internalCollabIds.map(profile_id => ({ project_id: proj.id, profile_id })));
    if (e4) { msg.innerHTML = `<div class="msg error">${e4.message}</div>`; return; }
  }

  closeModal('modal-new');
  // Reset checkboxes (form.reset() doesn't reach dynamically-created checkboxes)
  document.querySelectorAll('.np-collab-check').forEach(cb => cb.checked = false);
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

  // Stage target dates + rename + add editor
  const stageDatesDiv = document.getElementById('pd-stage-dates');
  stageDatesDiv.innerHTML = d.stages.map((s, i) => {
    const isPast = i < d.currentIndex;
    const isCurrent = i === d.currentIndex;
    // Any editor (owner, PI, or collaborator) may remove a planned stage —
    // the current one or any future one; completed (past) stages stay locked.
    const canDelete = canEdit(project) && !isPast;
    const nameEditable = canEdit(project) && !isPast;
    const nameEl = nameEditable
      ? `<input type="text" value="${escapeHtml(s.name)}" data-stage-id="${s.id}" class="pd-stage-name" style="flex:1; font-size:13px; ${isCurrent ? 'color:var(--accent); font-weight:500;' : ''}">`
      : `<span style="flex:1; font-size:13px; color:var(--text-faint); text-decoration:line-through;">${escapeHtml(s.name)}</span>`;
    const dragHandle = canEdit(project)
      ? `<span class="pd-drag" draggable="true" title="Drag to reorder" style="cursor:grab;user-select:none;color:var(--text-faint);padding:0 2px;flex-shrink:0;">⠿</span>`
      : '';
    return `
    <div class="stage-editor-row" style="margin-bottom:5px;">
      ${dragHandle}${nameEl}
      <input type="date" value="${s.target_date || ''}" data-stage-id="${s.id}"
        class="pd-stage-date" style="width:160px;" ${canEdit(project) ? '' : 'disabled'}>
      ${canDelete ? `<button type="button" class="subtle pd-delete-stage" data-stage-id="${s.id}" data-stage-name="${escapeHtml(s.name)}" title="Remove this stage">✕</button>` : '<span style="width:32px;flex-shrink:0;"></span>'}
    </div>`;
  }).join('');

  document.getElementById('pd-add-stage').style.display = canEdit(project) ? 'inline-block' : 'none';

  if (canEdit(project)) {
    stageDatesDiv.querySelectorAll('.pd-delete-stage').forEach(btn => {
      btn.addEventListener('click', async () => {
        const stageId = btn.dataset.stageId;
        const name = btn.dataset.stageName;
        if (!confirm(`Remove the "${name}" stage from this project? This can't be undone.`)) return;

        // If we're deleting the current stage, move the project's "current" marker
        // to the next stage (or the previous one if this was the last) so the open
        // stage_history entry keeps pointing at a real stage.
        if (d.current && d.currentIndex >= 0 && d.stages[d.currentIndex]?.id === stageId) {
          const target = d.stages[d.currentIndex + 1] || d.stages[d.currentIndex - 1] || null;
          if (target) {
            await supabaseClient.from('stage_history')
              .update({ stage_name: target.name }).eq('id', d.current.id);
          }
        }
        await supabaseClient.from('project_stages').delete().eq('id', stageId);
        await loadAll(); renderAll(); openProjectModal(STATE.openProjectId);
      });
    });
  }

  // Internal collaborators checkboxes
  const pdCollabs = document.getElementById('pd-internal-collabs');
  const others = STATE.profiles.filter(p => p.role !== 'pi' && p.id !== project.owner_id);
  if (others.length === 0) {
    pdCollabs.innerHTML = '<span style="font-size:13px;color:var(--text-faint);">No other lab members yet.</span>';
  } else {
    pdCollabs.innerHTML = others.map(p => {
      const checked = (project.internal_collaborator_ids || []).includes(p.id) ? 'checked' : '';
      const disabled = canManage(project) ? '' : 'disabled';
      return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" value="${p.id}" class="pd-collab-check" ${checked} ${disabled} style="width:auto;"> ${escapeHtml(p.full_name)}
      </label>`;
    }).join('');
  }

  document.getElementById('pd-venue').value = project.target_venue || '';
  document.getElementById('pd-deadline').value = project.target_deadline || '';
  document.getElementById('pd-collab').value = project.collaborators || '';
  document.getElementById('pd-notes').value = project.notes || '';
  ['pd-venue', 'pd-deadline', 'pd-collab', 'pd-notes'].forEach(fid => document.getElementById(fid).disabled = !canEdit(project));
  document.getElementById('pd-save').style.display = canEdit(project) ? 'inline-block' : 'none';

  document.getElementById('pd-back').style.display = (canEdit(project) && d.currentIndex > 0) ? 'inline-block' : 'none';
  document.getElementById('pd-advance').style.display = canEdit(project) ? 'inline-block' : 'none';
  document.getElementById('pd-advance').textContent = (d.currentIndex === d.stages.length - 1) ? 'Mark complete & archive' : 'Advance ▸';

  const archiveBtn = document.getElementById('pd-archive');
  archiveBtn.style.display = canManage(project) ? 'inline-block' : 'none';
  archiveBtn.textContent = project.status === 'archived' ? 'Re-activate' : 'Archive';
  document.getElementById('pd-delete').style.display = canManage(project) ? 'inline-block' : 'none';

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
  const msg = document.getElementById('pd-msg');

  // Refuse to save if the stage target dates run backwards in sequence.
  const pdDates = [...document.querySelectorAll('#pd-stage-dates .pd-stage-date')].map(el => el.value || null);
  if (datesOutOfOrder(pdDates)) {
    msg.innerHTML = "<div class=\"msg error\">Changes not saved — stage target dates aren't in chronological order.</div>";
    return;
  }

  // Save project fields
  const updates = {
    target_venue: document.getElementById('pd-venue').value || null,
    target_deadline: document.getElementById('pd-deadline').value || null,
    collaborators: document.getElementById('pd-collab').value || null,
    notes: document.getElementById('pd-notes').value || null,
  };
  const { error } = await supabaseClient.from('projects').update(updates).eq('id', project.id);
  if (error) { msg.innerHTML = `<div class="msg error">${error.message}</div>`; return; }

  // Persist stages in their current on-screen order (drag-to-reorder), together
  // with renames, dates, and any newly added rows. stage_history references
  // stages by name (a string snapshot), so a rename is propagated to history —
  // otherwise the project's "current stage" can no longer be matched.
  const oldNameById = new Map(project.project_stages.map(s => [String(s.id), s.name]));
  const rows = [...document.querySelectorAll('#pd-stage-dates .stage-editor-row')];
  const toInsert = [];
  for (let i = 0; i < rows.length; i++) {
    const sort_order = i + 1;
    const dateEl = rows[i].querySelector('.pd-stage-date');
    const nameEl = rows[i].querySelector('.pd-stage-name'); // input for current/future/new; absent for past
    const target_date = dateEl?.value || null;
    const stageId = dateEl?.dataset.stageId;                // present only for existing stages

    if (stageId) {
      const update = { sort_order, target_date };
      if (nameEl) {                                         // renameable (current/future) stage
        const newName = nameEl.value.trim() || nameEl.value;
        update.name = newName;
        const oldName = oldNameById.get(String(stageId));
        if (oldName && oldName !== newName) {
          await supabaseClient.from('stage_history')
            .update({ stage_name: newName })
            .eq('project_id', project.id).eq('stage_name', oldName);
        }
      }
      await supabaseClient.from('project_stages').update(update).eq('id', stageId);
    } else if (nameEl) {                                    // brand-new stage added this session
      toInsert.push({
        project_id: project.id,
        name: nameEl.value.trim() || 'New stage',
        sort_order,
        target_date,
      });
    }
  }
  if (toInsert.length) {
    await supabaseClient.from('project_stages').insert(toInsert);
  }

  // Save internal collaborator changes (owner/PI only)
  if (canManage(project)) {
    const checkedIds = [...document.querySelectorAll('.pd-collab-check:checked')].map(cb => cb.value);
    // Delete all existing and re-insert — simplest way to handle add/remove
    const { error: delErr } = await supabaseClient.from('project_collaborators').delete().eq('project_id', project.id);
    if (delErr) { msg.innerHTML = `<div class="msg error">Couldn't update collaborators: ${delErr.message}</div>`; return; }
    if (checkedIds.length > 0) {
      const { error: insErr } = await supabaseClient.from('project_collaborators')
        .insert(checkedIds.map(profile_id => ({ project_id: project.id, profile_id })));
      if (insErr) { msg.innerHTML = `<div class="msg error">Couldn't add collaborators: ${insErr.message}</div>`; return; }
    }
  }

  await loadAll(); renderAll();
  // Re-render the modal from the freshly-loaded state so any stage we just
  // added now carries its database id. Without this, its input stays flagged
  // as a "new" stage and a second "Save details" click would insert it again
  // (this is how a project can accumulate dozens of duplicate stages).
  openProjectModal(STATE.openProjectId);
  document.getElementById('pd-msg').innerHTML = `<div class="msg ok">Saved.</div>`;
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
function updateReportButton() {
  const ownerFilter = document.getElementById('filter-owner').value;
  const btn = document.getElementById('btn-report');
  if (ownerFilter) {
    const name = STATE.profiles.find(p => p.id === ownerFilter)?.full_name || 'trainee';
    btn.textContent = `📄 ${name.split(' ')[0]}'s report`;
  } else {
    btn.textContent = isPI() ? '📄 Report' : '📄 My report';
  }
}

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

  document.getElementById('filter-owner').addEventListener('change', () => {
    renderProjectList();
    updateReportButton();
  });
  document.getElementById('filter-stage').addEventListener('change', renderProjectList);
  document.getElementById('filter-archived').addEventListener('change', renderProjectList);
  document.getElementById('sort-by').addEventListener('change', renderProjectList);

  document.getElementById('btn-report').addEventListener('click', () => {
    const ownerFilter = document.getElementById('filter-owner').value;
    // With a trainee selected → that trainee's report. Otherwise no uid:
    // report.html gives a PI the all-lab report and a trainee their own.
    window.open(ownerFilter ? `report.html?uid=${ownerFilter}` : 'report.html', '_blank');
  });
  updateReportButton();

  document.getElementById('pd-save').addEventListener('click', savePdDetails);
  document.getElementById('pd-add-stage').addEventListener('click', () => {
    const stageDatesDiv = document.getElementById('pd-stage-dates');
    const row = document.createElement('div');
    row.className = 'stage-editor-row';
    row.style.marginBottom = '5px';
    row.innerHTML = `
      <span class="pd-drag" draggable="true" title="Drag to reorder" style="cursor:grab;user-select:none;color:var(--text-faint);padding:0 2px;flex-shrink:0;">⠿</span>
      <input type="text" placeholder="Stage name" class="pd-stage-name" style="flex:1; font-size:13px;">
      <input type="date" class="pd-stage-date" style="width:160px;">
      <button type="button" class="subtle" title="Remove" onclick="this.closest('.stage-editor-row').remove()">✕</button>`;
    stageDatesDiv.appendChild(row);
  });

  // Drag-to-reorder for the detail-modal stage list. Delegated on the container
  // (wired once) so it also covers stages added after the modal was rendered;
  // the new order is written as sort_order when "Save details" is clicked.
  const pdStages = document.getElementById('pd-stage-dates');
  let pdDragged = null;
  pdStages.addEventListener('dragstart', e => {
    const handle = e.target.closest('.pd-drag');
    if (!handle) return;
    pdDragged = handle.closest('.stage-editor-row');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'stage'); // Firefox requires data
    pdDragged.style.opacity = '0.4';
  });
  pdStages.addEventListener('dragend', () => { if (pdDragged) pdDragged.style.opacity = ''; });
  pdStages.addEventListener('dragover', e => {
    if (pdDragged) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  pdStages.addEventListener('drop', e => {
    if (!pdDragged) return;
    e.preventDefault();
    const row = e.target.closest('.stage-editor-row');
    if (row && row !== pdDragged && row.parentNode === pdStages) {
      const kids = [...pdStages.children];
      if (kids.indexOf(pdDragged) < kids.indexOf(row)) row.after(pdDragged);
      else row.before(pdDragged);
    }
    pdDragged.style.opacity = '';
    pdDragged = null;
  });

  document.getElementById('pd-advance').addEventListener('click', advanceStage);
  document.getElementById('pd-back').addEventListener('click', moveBack);
  document.getElementById('pd-archive').addEventListener('click', toggleArchive);
  document.getElementById('pd-delete').addEventListener('click', deleteProject);
}
