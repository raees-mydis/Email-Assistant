const axios  = require('axios');
const config = require('./config');

const BASE           = 'https://api.todoist.com/api/v1';
const PRIORITY_LEVEL = 3;

// Section name → ID mapping
const SECTIONS = {
  'operations':  null,
  'accounts':    null,
  'financial':   null,
  'support':     null,
  'install':     null,
  'logistics':   null,
  'sales':       null,
};

let _sectionsLoaded = false;

async function loadSections() {
  if (_sectionsLoaded) return;
  try {
    const res = await axios.get(BASE + '/sections', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const sections = res.data || [];
    console.log('[todoist] sections:', sections.map(s => s.id + ':' + s.name).join(', '));
    for (const s of sections) {
      const name = s.name.toLowerCase();
      if (name.includes('operation'))  SECTIONS['operations'] = s.id;
      if (name.includes('account') || name.includes('financial')) { SECTIONS['accounts'] = s.id; SECTIONS['financial'] = s.id; }
      if (name.includes('support'))    SECTIONS['support'] = s.id;
      if (name.includes('install'))    SECTIONS['install'] = s.id;
      if (name.includes('logistic'))   SECTIONS['logistics'] = s.id;
      if (name.includes('sales'))      SECTIONS['sales'] = s.id;
    }
    _sectionsLoaded = true;
    console.log('[todoist] mapped sections:', JSON.stringify(SECTIONS));
  } catch (err) {
    console.error('[todoist] section load error:', err.message);
  }
}

function matchSection(hint) {
  if (!hint) return SECTIONS['operations']; // default
  const h = hint.toLowerCase();
  if (h.includes('operat'))              return SECTIONS['operations'];
  if (h.includes('account') || h.includes('financ')) return SECTIONS['accounts'];
  if (h.includes('support') || h.includes('ticket')) return SECTIONS['support'];
  if (h.includes('install') || h.includes('logist')) return SECTIONS['install'];
  if (h.includes('sales'))               return SECTIONS['sales'];
  return SECTIONS['operations']; // default fallback
}

function headers() {
  return { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' };
}

async function createTask(opts) {
  await loadSections();
  const sectionId = matchSection(opts.section);
  const body = {
    content:     opts.title,
    description: opts.description || '',
    project_id:  config.todoist.projectId,
    priority:    PRIORITY_LEVEL,
    due_string:  opts.due_string || 'today',
    due_lang:    'en',
  };
  if (sectionId) body.section_id = sectionId;
  console.log('[todoist] creating:', JSON.stringify(body));
  const res = await axios.post(BASE + '/tasks', body, { headers: headers() });
  console.log('[todoist] created:', res.data.id, res.data.content);
  return res.data;
}

async function getTodayTasks() {
  try {
    const res = await axios.get(BASE + '/tasks', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const all = res.data || [];
    const today = new Date().toISOString().split('T')[0];
    return all.filter(t => {
      if (!t.due) return false;
      const dueDate = t.due.date;
      return dueDate <= today;
    });
  } catch (err) {
    console.error('[todoist] getTodayTasks error:', err.message);
    return [];
  }
}

async function updateTaskDue(taskId, dueString) {
  const res = await axios.post(BASE + '/tasks/' + taskId, {
    due_string: dueString,
    due_lang:   'en',
  }, { headers: headers() });
  return res.data;
}

async function postponeAllTasks(tasks, dueString) {
  const results = [];
  for (const task of tasks) {
    try {
      const updated = await updateTaskDue(task.id, dueString);
      results.push({ id: task.id, content: task.content, newDue: updated.due ? updated.due.date : dueString });
    } catch (err) {
      console.error('[todoist] postpone error for', task.id, err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

async function getTasksForDate(dateStr) {
  // dateStr format: YYYY-MM-DD
  try {
    const res = await axios.get(BASE + '/tasks', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const all = Array.isArray(res.data) ? res.data : (res.data.results || res.data.items || []);
    return all.filter(t => t.due && t.due.date === dateStr);
  } catch (err) {
    console.error('[todoist] getTasksForDate error:', err.message);
    return [];
  }
}

module.exports = { createTask, getTodayTasks, getTasksForDate, updateTaskDue, postponeAllTasks };
