/// <reference path="../pb_data/types.d.ts" />

/**
 * API Key hook — hash the raw key before storage.
 * Client sends the raw key in key_hash; this hook replaces it with SHA-256.
 */
onRecordCreate((e) => {
  const raw = e.record.get('key_hash')
  if (!raw) return

  const hash = $security.sha256(raw)
  e.record.set('key_hash', hash)

  if (!e.record.get('prefix')) {
    e.record.set('prefix', raw.substring(0, 7))
  }

  e.next()
}, 'api_keys')
