const axios  = require('axios');
const config = require('./config');

const BASE           = 'https://api.todoist.com/rest/v2';
const SECTION_ID     = '63g3JhMM48W9vCQ4'; // Operations section
const PRIORITY_LEVEL = 3;                   // P2 = orange flag = API value 3

async function createTask(opts) {
  const res = await axios.post(BASE + '/tasks', {
    content:     opts.title,
    description: opts.description || '',
    project_id:  config.todoist.projectId,
    section_id:  SECTION_ID,
    priority:    PRIORITY_LEVEL,
    due_string:  opts.due_string || 'in 3 days',
    due_lang:    'en',
  }, { headers: { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' } });
  return res.data;
}

async function getTodayTasks() {
  const res = await axios.get(BASE + '/tasks', {
    headers: { Authorization: 'Bearer ' + config.todoist.token },
    params: { project_id: config.todoist.projectId, filter: 'today | overdue' }
  });
  return res.data || [];
}

module.exports = { createTask, getTodayTasks };
