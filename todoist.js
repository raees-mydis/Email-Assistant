const axios  = require('axios');
const config = require('./config');

async function createTask(opts) {
  const res = await axios.post('https://api.todoist.com/rest/v2/tasks', {
    content: opts.title, description: opts.description || '',
    project_id: config.todoist.projectId, due_string: opts.due_string || 'in 3 days', due_lang: 'en',
  }, { headers: { Authorization: 'Bearer ' + config.todoist.token, 'Content-Type': 'application/json' } });
  return res.data;
}

module.exports = { createTask };
