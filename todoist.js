const axios  = require('axios');
const config = require('./config');

const BASE           = 'https://api.todoist.com/api/v1';
const PRIORITY_LEVEL = 3;

const SECTIONS = {
  'operations': null, 'accounts': null, 'financial': null,
  'support': null, 'install': null, 'logistics': null, 'sales': null,
};
let _sectionsLoaded = false;

async function loadSections() {
  if (_sectionsLoaded) return;
  try {
    const res = await axios.get(BASE + '/sections', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const raw = res.data;
    const sections = Array.isArray(raw) ? raw : (raw.results || raw.items || []);
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
  } catch (err) {
    console.error('[todoist] section load error:', err.message);
  }
}

function matchSection(hint) {
  if (!hint) return SECTIONS['operations'];
  const h = hint.toLowerCase();
  if (h.includes('operat'))                      return SECTIONS['operations'];
  if (h.includes('account') || h.includes('financ')) return SECTIONS['accounts'];
  if (h.includes('support') || h.includes('ticket')) return SECTIONS['support'];
  if (h.includes('install') || h.includes('logist')) return SECTIONS['install'];
  if (h.includes('sales'))                       return SECTIONS['sales'];
  return SECTIONS['operations'];
}

function headers() {
  return { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' };
}

// Safely extract task array from any API response format
function extractTasks(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.tasks)) return data.tasks;
  // Log the actual response to help debug
  console.log('[todoist] unexpected response format:', JSON.stringify(data).slice(0, 200));
  return [];
}

async function fetchAllTasks() {
  const res = await axios.get(BASE + '/tasks', {
    headers: { Authorization: 'Bearer ' + config.todoist.token },
    params: { project_id: config.todoist.projectId }
  });
  const tasks = extractTasks(res.data);
  console.log('[todoist] fetched', tasks.length, 'total tasks');
  return tasks;
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
  console.log('[todoist] creating task:', JSON.stringify(body));
  const res = await axios.post(BASE + '/tasks', body, { headers: headers() });
  const task = Array.isArray(res.data) ? res.data[0] : (res.data.results ? res.data.results[0] : res.data);
  console.log('[todoist] created:', task.id, task.content);
  return task;
}

async function getTodayTasks() {
  try {
    const all = await fetchAllTasks();
    const today = new Date().toISOString().split('T')[0];
    const due = all.filter(t => {
      if (!t.due) return false;
      return t.due.date <= today;
    });
    console.log('[todoist] tasks due today or overdue:', due.length);
    return due;
  } catch (err) {
    console.error('[todoist] getTodayTasks error:', err.message, err.response ? JSON.stringify(err.response.data).slice(0, 200) : '');
    return [];
  }
}

async function getTasksForDate(dateStr) {
  try {
    const all = await fetchAllTasks();
    return all.filter(t => t.due && t.due.date === dateStr);
  } catch (err) {
    console.error('[todoist] getTasksForDate error:', err.message);
    return [];
  }
}

async function updateTaskDue(taskId, dueString) {
  const res = await axios.post(BASE + '/tasks/' + taskId, {
    due_string: dueString, due_lang: 'en',
  }, { headers: headers() });
  return res.data;
}

async function postponeAllTasks(tasks, dueString) {
  const results = [];
  for (const task of tasks) {
    try {
      await updateTaskDue(task.id, dueString);
      results.push({ id: task.id, content: task.content });
    } catch (err) {
      console.error('[todoist] postpone error:', task.id, err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

module.exports = { createTask, getTodayTasks, getTasksForDate, updateTaskDue, postponeAllTasks };
