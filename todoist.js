const axios  = require('axios');
const config = require('./config');

const BASE           = 'https://api.todoist.com/rest/v2';
const PRIORITY_LEVEL = 3; // P2 = orange flag

// Cache the section ID after first lookup
let _sectionId = null;

async function getSectionId() {
  if (_sectionId) return _sectionId;
  try {
    const res = await axios.get(BASE + '/sections', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId }
    });
    const sections = res.data || [];
    console.log('[todoist] sections found:', sections.map(s => s.id + ':' + s.name).join(', '));
    const ops = sections.find(s => s.name.toLowerCase().includes('operation'));
    _sectionId = ops ? ops.id : null;
    console.log('[todoist] using section id:', _sectionId);
    return _sectionId;
  } catch (err) {
    console.error('[todoist] section lookup error:', err.message);
    return null;
  }
}

async function createTask(opts) {
  const sectionId = await getSectionId();
  const body = {
    content:    opts.title,
    description: opts.description || '',
    project_id: config.todoist.projectId,
    priority:   PRIORITY_LEVEL,
    due_string: opts.due_string || 'in 3 days',
    due_lang:   'en',
  };
  if (sectionId) body.section_id = sectionId;

  console.log('[todoist] creating task:', JSON.stringify(body));
  const res = await axios.post(BASE + '/tasks', body, {
    headers: { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' }
  });
  console.log('[todoist] task created:', res.data.id, res.data.content);
  return res.data;
}

async function getTodayTasks() {
  try {
    const res = await axios.get(BASE + '/tasks', {
      headers: { Authorization: 'Bearer ' + config.todoist.token },
      params: { project_id: config.todoist.projectId, filter: 'today | overdue' }
    });
    return res.data || [];
  } catch { return []; }
}

module.exports = { createTask, getTodayTasks };
