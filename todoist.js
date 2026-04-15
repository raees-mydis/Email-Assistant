const axios = require('axios');
const config = require('./config');

const BASE = 'https://api.todoist.com/rest/v2';

function headers() {
  return {
    Authorization:  `Bearer ${config.todoist.token}`,
    'Content-Type': 'application/json',
  };
}

async function createTask({ title, description, due_string }) {
  const res = await axios.post(`${BASE}/tasks`, {
    content:     title,
    description: description || '',
    project_id:  config.todoist.projectId,
    due_string:  due_string || 'in 3 days',
    due_lang:    'en',
  }, { headers: headers() });

  return res.data;
}

module.exports = { createTask };
