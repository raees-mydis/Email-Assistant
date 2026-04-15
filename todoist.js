const axios  = require('axios');
const config = require('./config');

const BASE           = 'https://api.todoist.com/rest/v2';
const PRIORITY_LEVEL = 3;

let _sectionId = null;

async function getSectionId() {
  if (_sectionId) return _sectionId;
  try {
    const res = await axios.get(BASE + '/sections', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const sections = res.data || [];
    console.log('[todoist] sections:', sections.map(s => s.id + ':' + s.name).join(', '));
    const ops = sections.find(s => s.name.toLowerCase().includes('operation'));
    _sectionId = ops ? ops.id : null;
    console.log('[todoist] section id:', _sectionId);
    return _sectionId;
  } catch (err) {
    console.error('[todoist] section error:', err.message);
    return null;
  }
}

function headers() {
  return { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' };
}

async function createTask(opts) {
  const sectionId = await getSectionId();
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

module.exports = { createTask, getTodayTasks, updateTaskDue, postponeAllTasks };
