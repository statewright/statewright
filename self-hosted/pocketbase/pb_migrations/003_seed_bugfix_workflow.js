/// <reference path="../pb_data/types.d.ts" />

/**
 * Seed the bugfix workflow from the template so it's ready to use immediately.
 */
migrate((app) => {
  const templates = app.findCollectionByNameOrId('workflow_templates')
  const workflows = app.findCollectionByNameOrId('workflows')
  const users = app.findCollectionByNameOrId('users')

  // Get the local user
  const user = app.findAuthRecordByEmail(users, 'local@statewright.local')

  // Get the bugfix template
  const tmpl = app.findFirstRecordByFilter(templates, "name = 'bugfix'")
  if (!tmpl) {
    console.log('No bugfix template found, skipping workflow seed')
    return
  }

  // Create the workflow
  const wf = new Record(workflows)
  wf.set('name', 'bugfix')
  wf.set('definition', tmpl.get('definition'))
  wf.set('active', true)
  wf.set('owner', user.id)
  wf.set('template_source', 'bugfix')
  app.save(wf)

  console.log('Seeded bugfix workflow for local user')
}, (app) => {
  try {
    const workflows = app.findCollectionByNameOrId('workflows')
    const wf = app.findFirstRecordByFilter(workflows, "name = 'bugfix'")
    if (wf) app.delete(wf)
  } catch (e) {}
})
