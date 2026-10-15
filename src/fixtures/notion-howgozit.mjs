// Builds the reference Howgozit Notion schema (reference/notion-native/interface.md §1) in a fake Notion, through the fake's own routes.
// Every value is invented. Returns the page id and the four data source ids.
const MODES = [['DO', 'red'], ['THINK', 'purple'], ['REVIEW', 'yellow'], ['LAUNCH', 'green'], ['Idea', 'gray']];

export async function seedHowgozit(fake, { habits = ['mood', 'walk'], modes = MODES } = {}) {
  const call = async (method, path, body) => {
    const res = await fake.fetch('https://api.notion.com' + path, {
      method,
      headers: { authorization: 'Bearer ' + (fake.token || 'ntn_fake_token'), 'notion-version': '2026-03-11', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`seedHowgozit: ${method} ${path} -> ${res.status} ${json.message}`);
    return json;
  };
  const dual = (data_source_id) => ({ relation: { data_source_id, type: 'dual_property', dual_property: {} } });
  const makeDb = async (page, title, properties) => {
    const db = await call('POST', '/v1/databases', { parent: { type: 'page_id', page_id: page }, title: [{ type: 'text', text: { content: title } }], initial_data_source: { properties } });
    return db.data_sources[0].id;
  };
  const rename = (ds, from, to) => call('PATCH', '/v1/data_sources/' + ds, { properties: { [from]: { name: to } } });

  const page = (await call('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: [{ text: { content: 'Howgozit' } }] } })).id;

  const projects = await makeDb(page, 'Projects', {
    'Project name': { title: {} }, ID: { unique_id: {} }, Status: { status: {} }, Priority: { select: { options: [] } },
    Dates: { date: {} }, Owner: { people: {} },
  });
  const goals = await makeDb(page, 'Goals', {
    'Goal name': { title: {} }, ID: { unique_id: {} }, Due: { date: {} }, Done: { checkbox: {} }, Project: dual(projects),
  });
  const tasks = await makeDb(page, 'Tasks', {
    'Task name': { title: {} }, ID: { unique_id: {} }, Status: { status: {} }, Due: { date: {} }, Priority: { select: { options: [] } },
    Tags: { multi_select: { options: modes.map(([name, color]) => ({ name, color })) } }, Assignee: { people: {} },
    Project: dual(projects), Goal: dual(goals),
  });
  await call('PATCH', '/v1/data_sources/' + tasks, { properties: { 'Blocked by': dual(tasks) } });
  const habitLog = await makeDb(page, 'Habit log', {
    Name: { title: {} }, ID: { unique_id: {} }, Habit: { select: { options: habits.map((name) => ({ name })) } },
    Date: { date: {} }, Done: { checkbox: {} }, Score: { number: { format: 'number' } },
  });

  // the synced twins carry Notion's "Related to ..." names until they are renamed
  await rename(projects, 'Related to Tasks (Project)', 'Tasks');
  await rename(projects, 'Related to Goals (Project)', 'Goals');
  await rename(goals, 'Related to Tasks (Goal)', 'Tasks');
  await rename(tasks, 'Related to Tasks (Blocked by)', 'Blocking');
  const rollup = (relation, by) => ({ rollup: { relation_property_name: relation, rollup_property_name: by, function: 'percent_per_group' } });
  await call('PATCH', '/v1/data_sources/' + projects, { properties: { Completion: rollup('Tasks', 'Status') } });
  await call('PATCH', '/v1/data_sources/' + goals, { properties: { Completion: rollup('Tasks', 'Status') } });

  return { page, projects, goals, tasks, habitLog };
}
