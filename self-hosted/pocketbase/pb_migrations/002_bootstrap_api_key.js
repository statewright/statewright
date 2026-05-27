/// <reference path="../pb_data/types.d.ts" />

/**
 * Bootstrap a local user and API key for self-hosted use.
 * Prints the key and a ready-to-paste shell alias to stdout on first run.
 */
migrate((app) => {
  // Create a local user
  const users = app.findCollectionByNameOrId('users')
  const user = new Record(users)
  user.set('email', 'local@statewright.local')
  user.set('password', $security.randomString(32))
  user.set('name', 'Local User')
  user.set('verified', true)
  app.save(user)

  // Generate API key
  const rawKey = 'sw_local_' + $security.randomString(32)

  // Create api_keys record — the hook will SHA-256 the key_hash field
  const keys = app.findCollectionByNameOrId('api_keys')
  const keyRecord = new Record(keys)
  keyRecord.set('owner', user.id)
  keyRecord.set('key_hash', rawKey)
  keyRecord.set('name', 'self-hosted-default')
  keyRecord.set('prefix', rawKey.substring(0, 12))
  app.save(keyRecord)

  // Save to file so it persists across restarts
  $os.writeFile('/pb/pb_data/.api_key', rawKey, 0o600)

  console.log('')
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  Statewright Self-Hosted — API Key Generated        ║')
  console.log('╠══════════════════════════════════════════════════════╣')
  console.log('║                                                      ║')
  console.log('║  ' + rawKey)
  console.log('║                                                      ║')
  console.log('║  Add to your shell profile:                          ║')
  console.log('║                                                      ║')
  console.log('║  alias spi=\'STATEWRIGHT_GATEWAY_URL=http://localhost:3001 \\')
  console.log('║    STATEWRIGHT_API_KEY=' + rawKey + ' \\')
  console.log('║    pi\'')
  console.log('║                                                      ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log('')
}, (app) => {
  try {
    const user = app.findAuthRecordByEmail('users', 'local@statewright.local')
    app.delete(user)
  } catch (e) {}
})
