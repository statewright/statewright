<template>
  <div class="min-h-screen bg-white">
    <div class="max-w-3xl mx-auto px-4 py-12">
      <div class="flex items-center justify-between mb-8">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">API Keys</h1>
          <p class="text-gray-600 text-sm mt-1">Keys for the MCP gateway to load workflows.</p>
        </div>
        <button
          @click="generateKey"
          :disabled="generating"
          class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
        >
          {{ generating ? 'Generating...' : 'Generate Key' }}
        </button>
      </div>

      <!-- Newly generated key (shown once) -->
      <div v-if="newKey" class="mb-8 bg-green-50 border border-green-200 rounded-lg p-4">
        <p class="text-sm font-semibold text-green-900 mb-2">New API key created. Copy it now — it won't be shown again.</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 bg-white border border-green-300 rounded px-3 py-2 text-sm font-mono text-green-800 select-all">{{ newKey }}</code>
          <button @click="copyKey" class="px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm transition-colors">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-gray-500 text-sm">Loading keys...</div>

      <div v-else-if="keys.length === 0 && !newKey" class="text-center py-12">
        <p class="text-gray-500 mb-2">No API keys yet.</p>
        <p class="text-gray-400 text-sm">Generate a key to connect agents to the gateway.</p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="key in keys"
          :key="key.id"
          class="bg-gray-50 border border-gray-200 rounded-lg px-5 py-4 flex items-center justify-between"
        >
          <div>
            <span class="font-mono text-sm text-gray-700">{{ key.prefix }}...</span>
            <span v-if="key.name" class="text-sm text-gray-500 ml-3">{{ key.name }}</span>
          </div>
          <div class="flex items-center gap-4">
            <span v-if="key.last_used" class="text-xs text-gray-400">Last used {{ formatDate(key.last_used) }}</span>
            <button @click="revokeKey(key)" class="text-xs text-red-400/60 hover:text-red-400 transition-colors">Revoke</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, inject, onMounted } from 'vue'

export default {
  setup() {
    const pocketbase = inject('pocketbase')
    const keys = ref([])
    const loading = ref(true)
    const generating = ref(false)
    const newKey = ref(null)
    const copied = ref(false)

    async function fetchKeys() {
      loading.value = true
      try {
        const records = await pocketbase.collection('api_keys').getFullList({ sort: '-created' })
        keys.value = records
      } catch (e) {
        console.error('Failed to fetch keys:', e)
      }
      loading.value = false
    }

    async function generateKey() {
      generating.value = true
      newKey.value = null
      copied.value = false
      try {
        // Generate a random key client-side, send it to PocketBase
        // The hook will hash it and store only the hash
        const raw = 'sw_' + crypto.randomUUID().replace(/-/g, '')
        const prefix = raw.slice(0, 7)
        await pocketbase.collection('api_keys').create({
          key_hash: raw, // Hook will hash this before storing
          prefix,
          name: 'Key ' + new Date().toLocaleDateString(),
        })
        newKey.value = raw
        await fetchKeys()
      } catch (e) {
        console.error('Failed to generate key:', e)
      }
      generating.value = false
    }

    async function revokeKey(key) {
      try {
        await pocketbase.collection('api_keys').delete(key.id)
        keys.value = keys.value.filter(k => k.id !== key.id)
      } catch (e) {
        console.error('Failed to revoke key:', e)
      }
    }

    function copyKey() {
      if (newKey.value) {
        navigator.clipboard.writeText(newKey.value)
        copied.value = true
      }
    }

    function formatDate(d) {
      if (!d) return ''
      return new Date(d).toLocaleDateString()
    }

    onMounted(fetchKeys)

    return { keys, loading, generating, newKey, copied, generateKey, revokeKey, copyKey, formatDate }
  }
}
</script>
