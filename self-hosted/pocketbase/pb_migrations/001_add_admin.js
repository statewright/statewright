migrate(
  (app) => {
    const superusers = app.findCollectionByNameOrId('_superusers')
    const record = new Record(superusers)
    record.set('email', 'admin@local.statewright')
    record.set('password', $security.randomString(32))
    app.save(record)
    console.log('Created default superuser: admin@local.statewright')
  },
  (app) => {
    try {
      const record = app.findAuthRecordByEmail('_superusers', 'admin@local.statewright')
      app.delete(record)
    } catch (e) {}
  }
)
