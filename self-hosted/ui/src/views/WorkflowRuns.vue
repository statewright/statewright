<template>
  <div class="min-h-screen bg-white">
    <div class="max-w-5xl mx-auto px-4 py-12">
      <div class="flex items-center justify-between mb-8">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">Run History</h1>
          <p class="text-gray-600 text-sm mt-1">{{ runs.length }} run{{ runs.length !== 1 ? 's' : '' }}</p>
        </div>
        <router-link to="/workflows" class="text-sm text-brand-600 hover:underline">&larr; Workflows</router-link>
      </div>

      <div v-if="loading" class="text-gray-500 text-sm">Loading runs...</div>

      <div v-else-if="runs.length === 0" class="text-center py-12">
        <p class="text-gray-500 mb-2">No workflow runs yet.</p>
        <p class="text-gray-400 text-sm">Activate a workflow via the gateway to see runs appear here.</p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="run in runs"
          :key="run.id"
          class="bg-gray-50 border border-gray-200 rounded-lg px-5 py-4 transition-colors"
          :class="{ 'border-brand-500/30': selectedRun === run.id }"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <button @click="toggleRun(run)" class="text-gray-500 hover:text-brand-500 transition-transform shrink-0"
                :class="{ 'rotate-90': selectedRun === run.id }">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
              </button>
              <span class="text-xs px-2 py-0.5 rounded font-semibold"
                :class="{
                  'bg-green-100 text-green-700': run.status === 'completed',
                  'bg-blue-100 text-blue-700': run.status === 'running',
                  'bg-red-100 text-red-700': run.status === 'failed',
                  'bg-gray-200 text-gray-600': run.status === 'stopped',
                }">{{ run.status }}</span>
              <span class="font-semibold text-gray-900">{{ run.workflow_name }}</span>
              <span v-if="run.final_state" class="text-xs text-gray-400">&rarr; {{ run.final_state }}</span>
            </div>
            <div class="flex items-center gap-4 text-xs text-gray-400">
              <span v-if="logCounts[run.id]" class="text-amber-400">{{ logCounts[run.id] }} logs</span>
              <span>{{ run.transition_count }} transitions</span>
              <span>{{ formatDuration(run) }}</span>
              <span>{{ formatDate(run.started_at) }}</span>
            </div>
          </div>

          <!-- Expanded: transition timeline + logs -->
          <div v-if="selectedRun === run.id" class="mt-4">
            <div v-if="run.transitions?.length" class="pl-2 border-l-2 border-brand-500/30 space-y-3">
              <div v-for="(t, i) in run.transitions" :key="i">
                <div class="flex items-center gap-3 text-xs">
                  <span class="text-gray-400 w-16 shrink-0 text-right">{{ formatTime(t.timestamp) }}</span>
                  <span class="text-gray-500">{{ t.from }}</span>
                  <span class="text-brand-400">&rarr;</span>
                  <span class="text-gray-900 font-medium">{{ t.to }}</span>
                  <span class="text-gray-600">({{ t.event }})</span>
                  <button v-if="runLogs[run.id]?.length" @click.stop="togglePhase(run.id, t.from)"
                    class="text-brand-400/60 hover:text-brand-400 text-[10px] ml-auto shrink-0">
                    {{ expandedPhases[run.id + ':' + t.from] ? 'hide logs' : 'logs' }}
                  </button>
                </div>
                <!-- Rationale -->
                <div v-if="t.data?.rationale" class="ml-20 mt-1 text-[11px] text-gray-600 italic bg-gray-100 rounded px-3 py-1.5 border border-gray-200">
                  {{ t.data.rationale }}
                </div>
                <!-- Tool logs for this phase -->
                <div v-if="expandedPhases[run.id + ':' + t.from] && runLogs[run.id]" class="ml-20 mt-2 space-y-1.5">
                  <div v-for="log in runLogs[run.id].filter(l => l.phase === t.from)" :key="log.id"
                    class="text-[10px] bg-gray-50 rounded px-3 py-2 font-mono border border-gray-200">
                    <div class="flex items-center gap-2 text-gray-500 cursor-pointer" @click.stop="toggleLog(log.id)">
                      <svg class="w-3 h-3 text-gray-500 transition-transform shrink-0" :class="{ 'rotate-90': expandedLogs[log.id] }" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                      <span class="text-brand-600 font-semibold">{{ log.tool_name }}</span>
                      <span v-if="parsed(log).label" class="text-gray-500 font-sans">{{ parsed(log).label }}</span>
                      <span v-if="log.duration_ms" class="text-gray-600 ml-auto">{{ log.duration_ms }}ms</span>
                    </div>

                    <pre v-if="!expandedLogs[log.id] && parsed(log).preview" class="text-gray-700 mt-1.5 whitespace-pre-wrap text-[9px] leading-relaxed max-h-[3.6em] overflow-hidden bg-gray-100 rounded px-2 py-1.5 border border-gray-200">{{ parsed(log).preview }}</pre>

                    <template v-if="expandedLogs[log.id]">
                      <div v-if="parsed(log).type === 'glob'" class="mt-1.5 space-y-0.5">
                        <div v-for="f in parsed(log).files" :key="f" class="text-gray-400 text-[9px]">{{ f }}</div>
                        <div v-if="parsed(log).truncated" class="text-gray-600 italic">results truncated</div>
                      </div>

                      <div v-else-if="parsed(log).type === 'read'" class="mt-1.5">
                        <div class="text-gray-500 text-[9px] mb-1">{{ parsed(log).path }}</div>
                        <pre class="text-gray-700 whitespace-pre-wrap max-h-64 overflow-y-auto text-[9px] leading-relaxed bg-gray-100 rounded px-2 py-1.5">{{ parsed(log).content }}</pre>
                      </div>

                      <div v-else-if="parsed(log).type === 'edit'" class="mt-1.5">
                        <div class="text-gray-500 text-[9px] mb-1">{{ parsed(log).path }}</div>
                        <pre class="text-red-600 whitespace-pre-wrap text-[9px] leading-relaxed line-through decoration-red-500/30">{{ parsed(log).oldString }}</pre>
                        <pre class="text-green-600 whitespace-pre-wrap text-[9px] leading-relaxed mt-0.5">{{ parsed(log).newString }}</pre>
                      </div>

                      <div v-else-if="parsed(log).type === 'bash'" class="mt-1.5">
                        <pre class="text-gray-700 whitespace-pre-wrap max-h-64 overflow-y-auto text-[9px] leading-relaxed bg-gray-100 rounded px-2 py-1.5">{{ parsed(log).stdout }}</pre>
                        <pre v-if="parsed(log).stderr" class="text-red-600 whitespace-pre-wrap max-h-24 overflow-y-auto text-[9px] leading-relaxed mt-1">{{ parsed(log).stderr }}</pre>
                      </div>

                      <div v-else-if="parsed(log).type === 'toolsearch'" class="mt-1 text-[9px] text-gray-500">
                        <span v-for="m in parsed(log).matches" :key="m" class="inline-block mr-2 text-gray-400">{{ m }}</span>
                      </div>

                      <pre v-else-if="log.tool_output" class="text-gray-700 mt-1 whitespace-pre-wrap max-h-64 overflow-y-auto text-[9px] leading-relaxed">{{ typeof log.tool_output === 'string' ? log.tool_output : JSON.stringify(log.tool_output, null, 2) }}</pre>
                    </template>
                  </div>
                  <div v-if="!runLogs[run.id].filter(l => l.phase === t.from).length" class="text-[10px] text-gray-600 italic">
                    No tool logs for this phase
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="text-sm text-gray-500">No transition data recorded.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, inject, onMounted, onUnmounted } from 'vue'

export default {
  setup() {
    const pocketbase = inject('pocketbase')
    const runs = ref([])
    const loading = ref(true)
    const selectedRun = ref(null)
    const runLogs = ref({})
    const logCounts = ref({})
    const expandedPhases = ref({})
    const expandedLogs = ref({})
    const parsedCache = new WeakMap()
    let sseUnsub = null
    let cancelled = false

    async function fetchRuns() {
      loading.value = true
      try {
        const result = await pocketbase.collection('workflow_runs').getList(1, 100, { sort: '-started_at' })
        runs.value = result.items
        for (const run of result.items) {
          if (logCounts.value[run.id] === undefined) fetchLogCount(run.id)
        }
      } catch (e) {
        console.error('Failed to fetch runs:', e)
      }
      loading.value = false
    }

    async function fetchLogCount(runId) {
      try {
        const result = await pocketbase.collection('workflow_logs').getList(1, 1, {
          filter: pocketbase.filter('run_id = {:rid}', { rid: runId }),
          fields: 'id'
        })
        logCounts.value[runId] = result.totalItems
      } catch (_) {}
    }

    async function fetchLogs(runId, run) {
      if (runLogs.value[runId]) return
      try {
        let records = await pocketbase.collection('workflow_logs').getList(1, 500, {
          filter: pocketbase.filter('run_id = {:rid}', { rid: runId }),
          sort: 'created'
        })
        let items = records.items
        if (!items.length && run?.started_at) {
          const start = run.started_at
          const end = run.completed_at || new Date().toISOString()
          records = await pocketbase.collection('workflow_logs').getList(1, 500, {
            filter: pocketbase.filter('created >= {:start} && created <= {:end}', { start, end }),
            sort: 'created'
          })
          items = records.items
        }
        runLogs.value[runId] = items
        logCounts.value[runId] = items.length
      } catch (_) {
        runLogs.value[runId] = []
        logCounts.value[runId] = 0
      }
    }

    function toggleRun(run) {
      if (selectedRun.value === run.id) {
        selectedRun.value = null
      } else {
        selectedRun.value = run.id
        fetchLogs(run.id, run)
      }
    }

    function preview(text, lines) {
      if (!text) return null
      const parts = String(text).split('\n').slice(0, lines || 3)
      return parts.length ? parts.join('\n') : null
    }

    function parsed(log) {
      if (parsedCache.has(log)) return parsedCache.get(log)
      const raw = log.tool_output
      let result
      if (!raw) { result = { type: 'empty' } }
      else {
        let d
        try { d = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { d = null }
        if (!d || typeof d !== 'object') {
          result = { type: 'text', preview: preview(raw) }
        } else if (d.filenames && Array.isArray(d.filenames)) {
          result = { type: 'glob', files: d.filenames, truncated: d.truncated, label: d.numFiles + ' files', preview: d.filenames.slice(0, 3).join(', ') }
        } else if (d.file && d.file.filePath && d.file.content !== undefined) {
          const name = d.file.filePath.split('/').pop()
          result = { type: 'read', path: d.file.filePath, content: d.file.content, label: name, preview: preview(d.file.content) }
        } else if (d.filePath && d.oldString !== undefined && d.newString !== undefined) {
          const name = d.filePath.split('/').pop()
          result = { type: 'edit', path: d.filePath, oldString: d.oldString, newString: d.newString, label: name, preview: '- ' + preview(d.oldString, 1) + '\n+ ' + preview(d.newString, 1) }
        } else if (d.stdout !== undefined || d.stderr !== undefined) {
          const exitLabel = d.exitCode !== undefined && d.exitCode !== 0 ? ' exit=' + d.exitCode : ''
          result = { type: 'bash', stdout: d.stdout || '', stderr: d.stderr || '', label: exitLabel || null, preview: preview(d.stdout || d.stderr) }
        } else if (d.matchedFiles || d.matches_by_file) {
          const files = d.matchedFiles || Object.keys(d.matches_by_file || {})
          result = { type: 'glob', files, label: files.length + ' matches', preview: files.slice(0, 3).join(', ') }
        } else if (d.matches && d.query) {
          result = { type: 'toolsearch', matches: d.matches, label: d.matches.length + ' found', preview: d.matches.slice(0, 2).join(', ') }
        } else {
          result = { type: 'json', preview: preview(JSON.stringify(d, null, 2)) }
        }
      }
      parsedCache.set(log, result)
      return result
    }

    function togglePhase(runId, phase) {
      const key = runId + ':' + phase
      expandedPhases.value[key] = !expandedPhases.value[key]
    }

    function toggleLog(logId) {
      expandedLogs.value[logId] = !expandedLogs.value[logId]
    }

    function formatDate(d) {
      if (!d) return ''
      return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    function formatTime(d) {
      if (!d) return ''
      return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    function formatDuration(run) {
      if (!run.started_at) return ''
      const start = new Date(run.started_at)
      const end = run.completed_at ? new Date(run.completed_at) : new Date()
      const ms = end - start
      if (ms < 60000) return Math.round(ms / 1000) + 's'
      if (ms < 3600000) return Math.round(ms / 60000) + 'm'
      return Math.round(ms / 3600000 * 10) / 10 + 'h'
    }

    onMounted(async () => {
      await fetchRuns()
      try {
        const unsub = await pocketbase.collection('workflow_runs').subscribe('*', () => fetchRuns())
        if (cancelled) { unsub() } else { sseUnsub = unsub }
      } catch (_) {}
    })

    onUnmounted(() => { cancelled = true; if (sseUnsub) sseUnsub() })

    return { runs, loading, selectedRun, runLogs, logCounts, expandedPhases, expandedLogs, toggleRun, togglePhase, toggleLog, parsed, formatDate, formatTime, formatDuration }
  }
}
</script>
