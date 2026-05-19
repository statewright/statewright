<template>
  <div class="min-h-screen bg-white">
    <div class="max-w-5xl mx-auto px-4 py-12">
      <div class="flex items-center justify-between mb-8">
        <div>
          <h1 class="text-2xl font-bold text-gray-900">Workflows</h1>
          <p class="text-gray-600 text-sm mt-1">
            {{ workflows.length }} workflow{{ workflows.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <div class="flex gap-3">
          <button
            @click="showTemplates = !showTemplates"
            class="px-4 py-2 border border-brand-300 text-brand-700 hover:bg-brand-50 rounded-lg text-sm font-medium transition-colors"
          >
            {{ showTemplates ? 'Hide Templates' : 'From Template' }}
          </button>
          <button
            @click="showJsonImport = !showJsonImport"
            class="px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 rounded-lg text-sm font-medium transition-colors"
          >
            From JSON
          </button>
          <button
            @click="$router.push('/workflows/new')"
            class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            New Workflow
          </button>
        </div>
      </div>

      <!-- Templates -->
      <div v-if="showTemplates" class="mb-8 grid md:grid-cols-2 gap-4">
        <div
          v-for="t in templates"
          :key="t.name"
          class="bg-brand-50 border border-brand-200 rounded-lg p-4 cursor-pointer hover:border-brand-400 transition-colors"
          @click="forkTemplate(t)"
        >
          <h3 class="font-semibold text-brand-900 text-sm">{{ t.name }}</h3>
          <p class="text-gray-600 text-xs mt-1">{{ t.description }}</p>
          <div class="flex gap-1 mt-2 flex-wrap">
            <span
              v-for="state in Object.keys(t.definition.states).filter(s => t.definition.states[s].type !== 'final').slice(0, 4)"
              :key="state"
              class="text-xs bg-brand-100 text-brand-700 px-2 py-0.5 rounded"
            >{{ state }}</span>
            <span
              v-if="Object.keys(t.definition.states).filter(s => t.definition.states[s].type !== 'final').length > 4"
              class="text-xs bg-brand-100 text-brand-600 px-2 py-0.5 rounded cursor-default"
            >& {{ Object.keys(t.definition.states).filter(s => t.definition.states[s].type !== 'final').length - 4 }} more...</span>
          </div>
        </div>
      </div>

      <!-- JSON Import -->
      <div v-if="showJsonImport" class="mb-8 bg-gray-50 border border-gray-200 rounded-lg p-4">
        <label class="text-xs font-semibold text-gray-500 block mb-2">Paste workflow JSON:</label>
        <textarea
          v-model="jsonImportText"
          rows="6"
          class="w-full font-mono text-xs bg-white border border-gray-300 rounded-lg p-3 text-gray-900 resize-none focus:ring-brand-500 focus:border-brand-500 mb-3"
          placeholder='{"id": "my-workflow", "initial": "start", "states": { ... }}'
          spellcheck="false"
        ></textarea>
        <div class="flex gap-2">
          <button @click="importFromJson" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold transition-colors">
            Import
          </button>
          <span v-if="jsonImportError" class="text-xs text-red-400 self-center">{{ jsonImportError }}</span>
        </div>
      </div>

      <div v-if="loading" class="text-gray-500 text-sm">Loading workflows...</div>

      <div v-else-if="workflows.length === 0" class="text-center py-12">
        <p class="text-gray-500 mb-4">No workflows yet. Create one or start from a template.</p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="wf in workflows"
          :key="wf.id"
          class="bg-gray-50 border border-gray-200 rounded-lg px-5 py-4 hover:border-brand-300 transition-colors"
        >
          <div class="flex items-center justify-between">
            <router-link :to="'/workflows/' + wf.id" class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-gray-900">{{ wf.name }}</span>
                <span v-if="wf.active" class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">active</span>
                <span v-if="wf.definition?.meta?.capture_output" class="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">logging</span>
                <span v-if="wf.template_source" class="text-xs text-gray-400">from {{ wf.template_source }}</span>
              </div>
              <div class="flex gap-1 mt-1 flex-wrap">
                <span
                  v-for="state in getStateNames(wf.definition).slice(0, 4)"
                  :key="state"
                  class="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded"
                >{{ state }}</span>
                <span
                  v-if="getStateNames(wf.definition).length > 4"
                  class="text-xs bg-gray-200 text-gray-500 px-2 py-0.5 rounded cursor-default"
                >& {{ getStateNames(wf.definition).length - 4 }} more...</span>
              </div>
            </router-link>
            <div class="flex items-center gap-3 shrink-0 ml-4">
              <span class="text-xs text-gray-400">{{ formatDate(wf.updated) }}</span>
              <button
                @click.stop="deleteWorkflow(wf)"
                class="text-xs text-red-400/60 hover:text-red-400 transition-colors"
              >Delete</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, inject, onMounted } from 'vue'
import { useRouter } from 'vue-router'

export default {
  setup() {
    const pocketbase = inject('pocketbase')
    const router = useRouter()
    const workflows = ref([])
    const templates = ref([])
    const loading = ref(true)
    const showTemplates = ref(false)
    const showJsonImport = ref(false)
    const jsonImportText = ref('')
    const jsonImportError = ref('')

    async function fetchWorkflows() {
      loading.value = true
      try {
        const records = await pocketbase.collection('workflows').getFullList({ sort: '-updated' })
        workflows.value = records
      } catch (e) {
        console.error('Failed to fetch workflows:', e)
      }
      loading.value = false
    }

    async function fetchTemplates() {
      try {
        const records = await pocketbase.collection('workflow_templates').getFullList()
        templates.value = records
      } catch (e) {
        console.error('Failed to fetch templates:', e)
      }
    }

    async function forkTemplate(template) {
      try {
        const record = await pocketbase.collection('workflows').create({
          name: template.name,
          definition: template.definition,
          template_source: template.name,
          active: false
        })
        router.push('/workflows/' + record.id)
      } catch (e) {
        if (e.data?.data?.name?.code === 'validation_not_unique') {
          const record = await pocketbase.collection('workflows').create({
            name: template.name + '-' + Date.now().toString(36).slice(-4),
            definition: template.definition,
            template_source: template.name,
            active: false
          })
          router.push('/workflows/' + record.id)
        } else {
          console.error('Failed to fork template:', e)
        }
      }
    }

    async function deleteWorkflow(wf) {
      try {
        await pocketbase.collection('workflows').delete(wf.id)
        workflows.value = workflows.value.filter(w => w.id !== wf.id)
      } catch (e) {
        console.error('Failed to delete workflow:', e)
      }
    }

    async function importFromJson() {
      jsonImportError.value = ''
      try {
        const def = JSON.parse(jsonImportText.value)
        if (!def.states || !def.initial) throw new Error('Missing states or initial')
        const name = def.id || 'imported-' + Date.now().toString(36).slice(-4)
        const record = await pocketbase.collection('workflows').create({
          name,
          definition: def,
          active: false
        })
        router.push('/workflows/' + record.id)
      } catch (e) {
        jsonImportError.value = e.message || 'Invalid JSON'
      }
    }

    function getStateNames(def) {
      if (!def?.states) return []
      return Object.keys(def.states).filter(s => def.states[s]?.type !== 'final')
    }

    function formatDate(d) {
      if (!d) return ''
      return new Date(d).toLocaleDateString()
    }

    onMounted(() => {
      fetchWorkflows()
      fetchTemplates()
    })

    return { workflows, templates, loading, showTemplates, showJsonImport, jsonImportText, jsonImportError, forkTemplate, importFromJson, deleteWorkflow, getStateNames, formatDate }
  }
}
</script>
