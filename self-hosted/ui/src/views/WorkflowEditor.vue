<template>
  <div class="h-[calc(100vh-4rem)] flex flex-col bg-white text-gray-900 overflow-hidden">
    <!-- Top Bar -->
    <div class="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white/80 backdrop-blur shrink-0 z-10">
      <div class="flex items-center gap-3">
        <router-link to="/workflows" class="text-gray-400 hover:text-gray-900 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
        </router-link>
        <input
          v-model="name"
          class="text-lg font-bold bg-transparent border-none text-gray-900 focus:ring-0 p-0 w-64 placeholder-gray-400"
          placeholder="Workflow name"
        />
        <span v-if="saved" class="text-xs text-green-600">Saved</span>
        <span v-if="saveError" class="text-xs text-red-600">{{ saveError }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button @click="addState('normal')" class="text-xs px-2.5 py-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors">+ State</button>
        <button @click="addState('final')" class="text-xs px-2.5 py-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors">+ Final</button>
        <button @click="showToolCompendium = true" class="text-xs px-2.5 py-1.5 rounded-md text-brand-500 hover:bg-brand-50 transition-colors">Tools</button>
        <div class="w-px h-5 bg-gray-200 mx-1"></div>
        <button @click="showJson = !showJson" class="text-xs px-2.5 py-1.5 rounded-md transition-colors" :class="showJson ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'">
          {{ showJson ? 'Hide JSON' : 'View JSON' }}
        </button>
        <div class="w-px h-5 bg-gray-200 mx-1"></div>
        <select
          v-model="preferredClient"
          class="text-xs bg-gray-100 border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 focus:ring-brand-500 focus:border-brand-500"
          title="Default tool palette"
        >
          <option v-for="c in clientNames" :key="c" :value="c">{{ c }}</option>
        </select>
        <div class="w-px h-5 bg-gray-200 mx-1"></div>
        <label class="flex items-center gap-2 text-sm text-gray-500 cursor-pointer">
          <input type="checkbox" v-model="active" class="rounded border-gray-300 text-brand-600 focus:ring-brand-500 bg-white" />
          Active
        </label>
        <label class="flex items-center gap-2 text-sm text-gray-500 cursor-pointer">
          <input type="checkbox" v-model="captureOutput" class="rounded border-gray-300 text-amber-600 focus:ring-amber-500 bg-white" />
          Logging
        </label>
        <button @click="save" :disabled="saving" class="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button v-if="workflowId !== 'new'" @click="deleteWorkflow" class="text-sm text-red-500 hover:text-red-600 px-2 py-1.5 rounded-md hover:bg-red-50 transition-colors">
          Delete
        </button>
      </div>
    </div>

    <!-- Main content -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Canvas -->
      <div class="flex-1 relative">
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          :default-edge-options="defaultEdgeOptions"
          :connection-line-style="connectionLineStyle"
          :snap-to-grid="true"
          :snap-grid="[20, 20]"
          :delete-key-code="'Delete'"
          :fit-view-on-init="true"
          @connect="onConnect"
          @node-drag-stop="onDragStop"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @pane-click="onPaneClick"
          :class="['bg-gray-50', { 'has-selection': selectedNode }]"
        >
          <template #node-stateNode="nodeProps">
            <StateNode v-bind="nodeProps" />
          </template>
          <template #edge-offset="edgeProps">
            <OffsetEdge v-bind="edgeProps" />
          </template>
          <Background variant="dots" :gap="24" :size="1.5" pattern-color="#94a3b8" />

          <!-- Legend -->
          <div class="absolute bottom-3 left-3 z-10 bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-2 text-[10px] space-y-1.5">
            <div class="flex items-center gap-2">
              <svg width="28" height="6"><line x1="0" y1="3" x2="28" y2="3" stroke="#22c55e" stroke-width="2.5" stroke-dasharray="4 3"/></svg>
              <span class="text-gray-500">Happy path</span>
            </div>
            <div class="flex items-center gap-2">
              <svg width="28" height="6"><line x1="0" y1="3" x2="28" y2="3" stroke="#ef4444" stroke-width="1.5"/></svg>
              <span class="text-gray-500">Failure</span>
            </div>
            <div class="flex items-center gap-2">
              <svg width="28" height="6"><line x1="0" y1="3" x2="28" y2="3" stroke="#818cf8" stroke-width="2"/></svg>
              <span class="text-gray-500">Other transitions</span>
            </div>
          </div>
        </VueFlow>
      </div>

      <!-- Right sidebar: properties -->
      <transition name="slide-right">
        <div v-if="selectedNode || selectedEdge" class="w-[420px] border-l border-gray-200 bg-gray-50/90 overflow-y-auto shrink-0">
          <!-- Node properties -->
          <div v-if="selectedNode" class="p-5 space-y-5">
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider">State Properties</h3>

            <div>
              <label class="text-xs text-gray-500 block mb-1.5">Name</label>
              <input v-model="editLabel" @change="renameNode" class="w-full text-base bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 font-semibold focus:ring-brand-500 focus:border-brand-500" />
            </div>

            <div class="flex gap-2">
              <button @click="setInitial" class="text-xs px-4 py-1.5 rounded-lg font-medium transition-colors" :class="selectedNode.data.isInitial ? 'bg-brand-600 text-white' : 'bg-white text-gray-500 hover:text-gray-900 border border-gray-300'">Initial</button>
              <button @click="toggleFinal" class="text-xs px-4 py-1.5 rounded-lg font-medium transition-colors" :class="selectedNode.data.isFinal ? 'bg-gray-600 text-white' : 'bg-white text-gray-500 hover:text-gray-900 border border-gray-300'">Final</button>
            </div>

            <!-- Tools -->
            <div v-if="!selectedNode.data.isFinal">
              <label class="text-xs text-gray-500 font-normal block mb-2">Allowed Tools</label>
              <input v-model="toolSearch" placeholder="Filter tools..." class="w-full text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 mb-3 focus:ring-brand-500 focus:border-brand-500" />
              <div class="space-y-3 max-h-52 overflow-y-auto scrollbar-hide">
                <div v-for="cat in filteredToolCatalog" :key="cat.category">
                  <div class="text-[10px] text-gray-400 font-normal uppercase tracking-wider mb-1.5">{{ cat.category }}</div>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="tool in cat.tools" :key="tool"
                      @click="toggleTool(tool)"
                      :title="toolInfo[tool]?.desc || tool"
                      class="text-xs px-2.5 py-1 rounded-md transition-all font-medium"
                      :class="selectedNodeTools.includes(tool) ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/30' : 'bg-white text-gray-500 hover:text-gray-700 border border-gray-300 hover:border-gray-400'"
                    >{{ tool }}</button>
                  </div>
                </div>
              </div>
              <div class="mt-3">
                <input v-model="customToolName" @keyup.enter="addCustomTool" placeholder="+ custom tool name" class="w-full text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500" />
              </div>
            </div>

            <!-- Instructions -->
            <div v-if="!selectedNode.data.isFinal">
              <label class="text-xs text-gray-400 block mb-1.5">Instructions</label>
              <textarea :value="selectedNode.data.instructions" @input="updateInstruction($event.target.value)" rows="4" class="w-full text-xs bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 resize-none focus:ring-brand-500 focus:border-brand-500 leading-relaxed" placeholder="Instructions for the agent in this state..."></textarea>
            </div>

            <!-- Guards -->
            <div v-if="!selectedNode.data.isFinal">
              <label class="text-xs text-gray-400 block mb-2">Guards</label>
              <div class="space-y-2">
                <div class="flex items-center gap-3">
                  <label class="text-xs text-gray-500 w-24 shrink-0">Max iterations</label>
                  <input :value="selectedNode.data.maxIterations" @input="updateGuard('maxIterations', $event.target.value)" type="number" min="1" class="flex-1 text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="text-xs text-gray-500 w-24 shrink-0">Max edit lines</label>
                  <input :value="selectedNode.data.maxEditLines" @input="updateGuard('maxEditLines', $event.target.value)" type="number" min="1" class="flex-1 text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="text-xs text-gray-500 w-24 shrink-0">Max files</label>
                  <input :value="selectedNode.data.maxFilesPerState" @input="updateGuard('maxFilesPerState', $event.target.value)" type="number" min="1" class="flex-1 text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500" />
                </div>
                <div>
                  <label class="text-xs text-gray-500 block mb-1">Blocked env vars</label>
                  <div class="flex flex-wrap gap-1 mb-1">
                    <span v-for="(v, i) in (selectedNode.data.blockedEnv || '').split(',').map(s => s.trim()).filter(Boolean)" :key="'be'+i" class="inline-flex items-center gap-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-mono">
                      {{ v }}
                      <button @click="removeEnvItem('blockedEnv', i)" class="text-red-400 hover:text-red-300">&times;</button>
                    </span>
                  </div>
                  <input @keydown.enter.prevent="addEnvItem('blockedEnv', $event)" placeholder="+ add blocked var" class="w-full text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500 font-mono" />
                </div>
                <div>
                  <label class="text-xs text-gray-500 block mb-1">Env overrides</label>
                  <div class="space-y-1 mb-1">
                    <div v-for="(pair, i) in (selectedNode.data.envOverrides || '').split(',').map(s => s.trim()).filter(Boolean)" :key="'eo'+i" class="flex items-center gap-1 text-[10px] bg-brand-100 text-brand-700 px-2 py-0.5 rounded font-mono">
                      <span class="flex-1">{{ pair }}</span>
                      <button @click="removeEnvItem('envOverrides', i)" class="text-red-400 hover:text-red-300">&times;</button>
                    </div>
                  </div>
                  <input @keydown.enter.prevent="addEnvItem('envOverrides', $event)" placeholder="+ KEY=$VALUE" class="w-full text-xs bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500 font-mono" />
                </div>
              </div>
            </div>

            <!-- Outgoing transitions -->
            <div v-if="!selectedNode.data.isFinal">
              <label class="text-xs text-gray-400 block mb-2">Transitions</label>
              <div class="space-y-2">
                <div v-for="edge in selectedNodeEdges" :key="edge.id" class="flex items-center gap-2 group bg-gray-100 rounded-lg px-3 py-2">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="edgeTypeColor(edge.label)"></span>
                  <input v-model="edge.label" @change="onEdgeLabelChange(edge)" class="w-24 text-xs bg-white border border-gray-300 rounded-md px-2 py-1 text-brand-600 font-mono focus:ring-brand-500 focus:border-brand-500" />
                  <span class="text-gray-600 text-xs">&rarr;</span>
                  <span class="text-xs text-gray-500 flex-1 font-medium">{{ edge.target }}</span>
                  <button @click="removeEdge(edge)" class="text-red-500/0 group-hover:text-red-400/70 hover:!text-red-400 transition-colors text-sm">&times;</button>
                </div>

                <div class="flex items-center gap-1.5 mt-1">
                  <input v-model="newTransitionEvent" placeholder="Event" class="w-20 text-xs bg-white border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 font-mono focus:ring-brand-500 focus:border-brand-500" @keyup.enter="addTransitionFromSidebar" />
                  <span class="text-gray-500 text-xs">&rarr;</span>
                  <select v-model="newTransitionTarget" class="flex-1 text-xs bg-white border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 focus:ring-brand-500 focus:border-brand-500">
                    <option value="">Target...</option>
                    <option v-for="n in otherNodes" :key="n.id" :value="n.id">{{ n.id }}</option>
                  </select>
                  <button @click="addTransitionFromSidebar" class="text-xs text-brand-400 hover:text-brand-300 px-1.5 font-semibold shrink-0">+</button>
                </div>
              </div>
            </div>

            <div class="pt-2 border-t border-gray-200">
              <button @click="deleteSelected" class="w-full text-xs text-red-400/70 hover:text-red-400 py-2.5 rounded-lg hover:bg-red-50 transition-colors">Delete State</button>
            </div>
          </div>

          <!-- Edge properties -->
          <div v-if="selectedEdge && !selectedNode" class="p-5 space-y-5">
            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Transition</h3>
            <div>
              <label class="text-xs text-gray-500 block mb-1.5">Event Name</label>
              <input v-model="selectedEdge.label" @change="onEdgeLabelChange(selectedEdge)" class="w-full text-base bg-white border border-gray-300 rounded-lg px-3 py-2 text-brand-600 font-mono focus:ring-brand-500 focus:border-brand-500" />
            </div>
            <div class="text-xs text-gray-500">
              <span class="text-gray-700 font-medium">{{ selectedEdge.source }}</span>
              <span class="mx-2">&rarr;</span>
              <span class="text-gray-700 font-medium">{{ selectedEdge.target }}</span>
            </div>
            <button @click="removeEdge(selectedEdge)" class="w-full text-xs text-red-400/70 hover:text-red-400 py-2.5 rounded-lg hover:bg-red-50 transition-colors">Delete Transition</button>
          </div>
        </div>
      </transition>
    </div>

    <!-- Bottom: JSON editor (collapsible) -->
    <div v-if="showJson" class="border-t border-gray-200 flex-[3] min-h-0 flex flex-col">
      <div class="flex items-center justify-between px-4 py-1.5 bg-gray-50 shrink-0">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-semibold">JSON Definition</span>
        <div class="flex gap-3">
          <span v-if="parseError" class="text-xs text-red-500">{{ parseError }}</span>
          <span v-else-if="validationErrors.length" class="text-xs text-yellow-600">{{ validationErrors.length }} warning(s)</span>
          <span v-else class="text-xs text-green-600">Valid</span>
        </div>
      </div>
      <div class="flex-1 relative overflow-hidden">
        <pre ref="jsonPre" class="absolute inset-0 font-mono text-sm bg-white p-4 overflow-auto pointer-events-none whitespace-pre" aria-hidden="true" v-html="highlightedJson"></pre>
        <textarea ref="jsonTextarea" v-model="jsonText" @input="onJsonChange" @scroll="syncJsonScroll" class="json-editor absolute inset-0 w-full h-full font-mono text-sm bg-transparent text-transparent caret-gray-900 border-none p-4 resize-none focus:ring-0 z-10" spellcheck="false"></textarea>
      </div>
    </div>

    <!-- Connection event name dialog -->
    <div v-if="connectDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="bg-white rounded-xl p-5 w-80 shadow-2xl border border-gray-200">
        <h3 class="text-sm font-bold text-gray-900 mb-1">Transition Event</h3>
        <p class="text-[10px] text-gray-500 mb-4">
          <span class="text-gray-700">{{ connectDialog.source }}</span> &rarr; <span class="text-gray-700">{{ connectDialog.target }}</span>
        </p>
        <input ref="eventNameInput" v-model="connectDialog.eventName" @keyup.enter="confirmConnect" @keyup.esc="cancelConnect" class="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2.5 text-brand-600 font-mono focus:ring-brand-500 focus:border-brand-500" placeholder="DONE, FAIL, READY, PASS..." />
        <div class="flex gap-2 mt-4">
          <button @click="confirmConnect" class="flex-1 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors">Add</button>
          <button @click="cancelConnect" class="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-lg transition-colors">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Tool Compendium modal -->
    <div v-if="showToolCompendium" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" @click.self="showToolCompendium = false">
      <div class="bg-white rounded-xl p-6 w-[560px] max-h-[70vh] shadow-2xl border border-gray-200 flex flex-col">
        <div class="flex items-center justify-between mb-3 shrink-0">
          <h3 class="text-lg font-bold text-gray-900">Tool Compendium</h3>
          <button @click="showToolCompendium = false" class="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>

        <div class="flex gap-1 mb-3 shrink-0 overflow-x-auto scrollbar-hide">
          <button
            v-for="c in clientNames" :key="c"
            @click="compendiumClient = c; compendiumSelectedTool = null"
            class="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors font-medium"
            :class="compendiumClient === c ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'"
          >{{ c }}</button>
        </div>

        <input v-model="compendiumSearch" placeholder="Search tools..." class="w-full text-sm bg-gray-50 border border-gray-300 rounded-lg px-3 py-2.5 text-gray-900 mb-4 shrink-0 focus:ring-brand-500 focus:border-brand-500" autofocus />

        <div v-if="compendiumSelectedTool" class="mb-4 p-4 bg-brand-50 border border-brand-200 rounded-lg shrink-0">
          <div class="flex items-center justify-between mb-1">
            <span class="text-base font-bold text-gray-900">{{ compendiumSelectedTool }}</span>
            <span class="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full uppercase tracking-wider font-medium">{{ toolInfo[compendiumSelectedTool]?.source || 'Unknown' }}</span>
          </div>
          <p class="text-xs text-gray-600 leading-relaxed">{{ toolInfo[compendiumSelectedTool]?.desc || 'No description available.' }}</p>
        </div>

        <div class="flex-1 overflow-y-auto space-y-4 scrollbar-hide">
          <div v-for="cat in filteredCompendium" :key="cat.category">
            <div class="text-[10px] text-gray-400 font-normal uppercase tracking-wider mb-2">{{ cat.category }}</div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="tool in cat.tools" :key="tool"
                @click="compendiumSelectedTool = compendiumSelectedTool === tool ? null : tool"
                class="text-sm px-3 py-1.5 rounded-lg font-medium transition-all"
                :class="compendiumSelectedTool === tool ? 'bg-brand-600 text-white shadow-sm shadow-brand-500/30' : 'bg-gray-100 text-gray-700 border border-gray-200 hover:border-brand-300'"
              >{{ tool }}</button>
            </div>
          </div>
          <div v-if="!filteredCompendium.length" class="text-sm text-gray-400 py-8 text-center">No tools match "{{ compendiumSearch }}"</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, inject, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow, MarkerType, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from 'dagre'
import StateNode from '../components/workflow/StateNode.vue'
import OffsetEdge from '../components/workflow/OffsetEdge.vue'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const DEFAULT_TOOL_INFO = {
  Read:         { source: 'Claude Code', desc: 'Read file contents by path. Supports line ranges, PDFs, images, and notebooks.' },
  Edit:         { source: 'Claude Code', desc: 'Replace exact strings in a file. Requires reading the file first.' },
  Write:        { source: 'Claude Code', desc: 'Create or overwrite a file. Use Edit for partial changes.' },
  MultiEdit:    { source: 'Claude Code', desc: 'Apply multiple edits to a single file atomically.' },
  Glob:         { source: 'Claude Code', desc: 'Find files by glob pattern. Sorted by modification time.' },
  Grep:         { source: 'Claude Code', desc: 'Search file contents with regex. Supports context lines and file type filters.' },
  LS:           { source: 'Claude Code', desc: 'List directory contents.' },
  Bash:         { source: 'Claude Code', desc: 'Execute shell commands. Sandboxed with configurable timeout.' },
  Agent:        { source: 'Claude Code', desc: 'Spawn a sub-agent for complex multi-step tasks.' },
  WebFetch:     { source: 'Claude Code', desc: 'Fetch a URL and return its content.' },
  WebSearch:    { source: 'Claude Code', desc: 'Search the web and return results.' },
  NotebookEdit: { source: 'Claude Code', desc: 'Edit Jupyter notebook cells.' },
  shell:        { source: 'Codex', desc: 'Execute shell commands in a sandboxed environment.' },
  read_file:    { source: 'Codex', desc: 'Read file contents from the workspace.' },
  write_file:   { source: 'Codex', desc: 'Write or overwrite a file in the workspace.' },
  apply_patch:  { source: 'Codex', desc: 'Apply a unified diff patch to one or more files.' },
  edit_file:    { source: 'Cursor', desc: 'Edit a file with a streamed replacement.' },
  read_file_cursor: { source: 'Cursor', desc: 'Read file contents with line range support.' },
  run_terminal_cmd: { source: 'Cursor', desc: 'Run a command in the integrated terminal.' },
  codebase_search: { source: 'Cursor', desc: 'Semantic search across the codebase.' },
  grep_search:  { source: 'Cursor', desc: 'Regex search across files.' },
  file_search:  { source: 'Cursor', desc: 'Find files by name pattern.' },
  list_dir:     { source: 'Cursor', desc: 'List directory contents with metadata.' },
  read:         { source: 'opencode', desc: 'Read file contents. Similar to Claude Code Read.' },
  write:        { source: 'opencode', desc: 'Write file contents. Similar to Claude Code Write.' },
  bash:         { source: 'opencode', desc: 'Execute shell commands.' },
  glob:         { source: 'opencode', desc: 'Find files by glob pattern.' },
  grep:         { source: 'opencode', desc: 'Search file contents with regex.' },
  ReadFile:     { source: 'Pi', desc: 'Read file contents from the workspace.' },
  WriteFile:    { source: 'Pi', desc: 'Write or create a file.' },
  RunCommand:   { source: 'Pi', desc: 'Execute a shell command.' },
  SearchFiles:  { source: 'Pi', desc: 'Search for files by name or content.' },
}

const DEFAULT_CLIENT_CATALOGS = {
  'Claude Code': [
    { category: 'File', tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS'] },
    { category: 'Execute', tools: ['Bash', 'Agent'] },
    { category: 'Web', tools: ['WebFetch', 'WebSearch'] },
    { category: 'Notebook', tools: ['NotebookEdit'] },
  ],
  'Codex': [
    { category: 'Core', tools: ['shell', 'read_file', 'write_file', 'apply_patch'] },
  ],
  'Cursor': [
    { category: 'File', tools: ['edit_file', 'read_file_cursor', 'list_dir'] },
    { category: 'Search', tools: ['codebase_search', 'grep_search', 'file_search'] },
    { category: 'Execute', tools: ['run_terminal_cmd'] },
  ],
  'opencode': [
    { category: 'Core', tools: ['read', 'write', 'bash', 'glob', 'grep'] },
  ],
  'Pi': [
    { category: 'Core', tools: ['ReadFile', 'WriteFile', 'RunCommand', 'SearchFiles'] },
  ],
}

const HAPPY_EVENTS = ['DONE', 'PASS', 'READY', 'COMPLETE', 'EXTRACTED', 'VALID', 'TRANSFORMED', 'LOADED', 'READ', 'ANALYZED', 'REPORTED', 'SENT', 'CLASSIFIED']

function edgeType(eventName) {
  const upper = (eventName || '').toUpperCase()
  if (upper.includes('FAIL') || upper.includes('ERROR')) return 'fail'
  if (HAPPY_EVENTS.includes(upper)) return 'happy'
  return 'neutral'
}

function edgeStyle(eventName) {
  const type = edgeType(eventName)
  const colors = {
    happy:   { stroke: '#22c55e', label: '#166534' },
    fail:    { stroke: '#ef4444', label: '#991b1b' },
    neutral: { stroke: '#818cf8', label: '#3730a3' },
  }
  const c = colors[type]
  return {
    type: 'smoothstep',
    animated: type === 'happy',
    markerEnd: { type: MarkerType.ArrowClosed, color: c.stroke },
    style: { stroke: c.stroke, strokeWidth: type === 'happy' ? 2.5 : type === 'fail' ? 1.5 : 2 },
    labelStyle: { fill: c.label, fontWeight: 600, fontSize: 11 },
    labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
    labelBgPadding: [6, 4],
    labelBgBorderRadius: 4,
  }
}

export default {
  components: { VueFlow, Background, StateNode, OffsetEdge },
  setup() {
    const pocketbase = inject('pocketbase')
    const { getViewport, setViewport, dimensions: vpDimensions } = useVueFlow()
    const route = useRoute()
    const router = useRouter()

    const workflowId = ref(route.params.id)
    const name = ref('')
    const active = ref(false)
    const captureOutput = ref(false)
    const saving = ref(false)
    const saved = ref(false)
    const saveError = ref(null)
    const showJson = ref(false)
    const jsonText = ref('')
    const parseError = ref(null)
    const validationErrors = ref([])

    const nodes = ref([])
    const edges = ref([])
    const selectedNode = ref(null)
    const selectedEdge = ref(null)
    const editLabel = ref('')
    const connectDialog = ref(null)
    const toolSearch = ref('')
    const showToolCompendium = ref(false)
    const compendiumSearch = ref('')
    const compendiumSelectedTool = ref(null)
    const preferredClient = ref('Claude Code')
    const compendiumClient = ref('All')
    const newTransitionEvent = ref('')
    const newTransitionTarget = ref('')

    const toolInfo = ref({ ...DEFAULT_TOOL_INFO })
    const clientCatalogs = ref({ ...DEFAULT_CLIENT_CATALOGS })
    const clientNames = computed(() => ['All', ...Object.keys(clientCatalogs.value)])
    const customToolName = ref('')
    const eventNameInput = ref(null)
    const jsonPre = ref(null)
    const jsonTextarea = ref(null)

    let syncingFromJson = false
    let syncingFromFlow = false

    const connectionLineStyle = { stroke: '#6366f1', strokeWidth: 2 }

    const defaultEdgeOptions = {
      type: 'smoothstep',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#818cf8' },
      style: { stroke: '#818cf8', strokeWidth: 2 },
      labelStyle: { fill: '#3730a3', fontWeight: 600, fontSize: 11 },
      labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
      labelBgPadding: [6, 4],
      labelBgBorderRadius: 4,
    }

    const filteredToolCatalog = computed(() => {
      const merged = []
      const seen = new Set()
      const preferred = preferredClient.value
      for (const client of Object.keys(clientCatalogs.value)) {
        const isMcp = client.startsWith('MCP:')
        if (client !== preferred && !isMcp) continue
        for (const cat of clientCatalogs.value[client]) {
          const label = isMcp ? client.replace(/^MCP:/, '') : cat.category
          const tools = cat.tools.filter(t => { if (seen.has(t)) return false; seen.add(t); return true })
          if (tools.length) merged.push({ category: label, tools })
        }
      }
      if (!toolSearch.value) return merged
      const q = toolSearch.value.toLowerCase()
      return merged.map(cat => ({ ...cat, tools: cat.tools.filter(t => t.toLowerCase().includes(q)) })).filter(cat => cat.tools.length)
    })

    const selectedNodeTools = computed(() => selectedNode.value?.data?.tools || [])
    const selectedNodeEdges = computed(() => { if (!selectedNode.value) return []; return edges.value.filter(e => e.source === selectedNode.value.id) })
    const otherNodes = computed(() => { if (!selectedNode.value) return nodes.value; return nodes.value.filter(n => n.id !== selectedNode.value.id) })

    const filteredCompendium = computed(() => {
      let catalogs
      if (compendiumClient.value === 'All') {
        catalogs = []
        const seen = new Set()
        for (const client of Object.keys(clientCatalogs.value)) {
          for (const cat of clientCatalogs.value[client]) {
            const label = client === 'Claude Code' ? cat.category : client + ': ' + cat.category
            const tools = cat.tools.filter(t => { if (seen.has(t)) return false; seen.add(t); return true })
            if (tools.length) catalogs.push({ category: label, tools })
          }
        }
      } else {
        catalogs = clientCatalogs.value[compendiumClient.value] || []
      }
      if (!compendiumSearch.value) return catalogs
      const q = compendiumSearch.value.toLowerCase()
      return catalogs.map(cat => ({ ...cat, tools: cat.tools.filter(t => t.toLowerCase().includes(q)) })).filter(cat => cat.tools.length)
    })

    const highlightedJson = computed(() => {
      const text = jsonText.value || ''
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"([^"]*)"(\s*:)/g, '<span class="text-brand-600">"$1"</span>$2')
        .replace(/:\s*"([^"]*)"/g, ': <span class="text-green-700">"$1"</span>')
        .replace(/:\s*(\d+)/g, ': <span class="text-amber-600">$1</span>')
        .replace(/:\s*(true|false|null)/g, ': <span class="text-red-500">$1</span>')
    })

    // --- Dagre layout ---
    function runLayout() {
      if (!nodes.value.length) return
      const g = new dagre.graphlib.Graph()
      g.setDefaultEdgeLabel(() => ({}))
      g.setGraph({ rankdir: 'TB', nodesep: 160, ranksep: 160, marginx: 40, marginy: 40 })
      nodes.value.forEach(n => { g.setNode(n.id, { width: 240, height: n.data.isFinal ? 50 : 130 }) })
      edges.value.forEach(e => g.setEdge(e.source, e.target))
      dagre.layout(g)
      var ranks = {}
      nodes.value.forEach(n => { var pos = g.node(n.id); if (pos) ranks[n.id] = Math.round(pos.y / 100) })
      nodes.value = nodes.value.map(n => {
        const pos = g.node(n.id)
        if (!pos) return n
        const h = n.data.isFinal ? 50 : 130
        const stagger = (ranks[n.id] || 0) % 2 === 1 ? 200 : 0
        return { ...n, position: { x: pos.x - 120 + stagger, y: pos.y - h / 2 } }
      })
    }

    // --- Conversion: definition <-> flow ---
    function definitionToFlow(def) {
      const ns = []
      const es = []
      Object.entries(def.states || {}).forEach(([stateName, state]) => {
        const pos = state._position || { x: 0, y: 0 }
        const transitions = state.on ? Object.entries(state.on).map(([event, target]) => ({ event, target: typeof target === 'string' ? target : target.target })) : []
        ns.push({
          id: stateName, type: 'stateNode', position: { ...pos },
          data: {
            label: stateName, isInitial: stateName === def.initial, isFinal: state.type === 'final',
            tools: state.allowed_tools ? [...state.allowed_tools] : [], instructions: state.instructions || '',
            maxIterations: state.max_iterations || null, maxEditLines: state.max_edit_lines || null,
            maxFilesPerState: state.max_files_per_state || null, allowedCommands: state.allowed_commands ? [...state.allowed_commands] : [],
            contextBudgetBytes: state.context_budget_bytes || null,
            blockedEnv: state.blocked_env ? state.blocked_env.join(', ') : '',
            envOverrides: state.env_overrides ? Object.entries(state.env_overrides).map(([k,v]) => k + '=' + v).join(', ') : '',
            transitions,
          }
        })
        if (state.on) {
          Object.entries(state.on).forEach(([event, target]) => {
            const targetName = typeof target === 'string' ? target : target.target
            es.push({ id: `${stateName}-${event}-${targetName}`, source: stateName, target: targetName, sourceHandle: `source-${event}`, targetHandle: `target-${stateName}-${event}`, label: event, ...edgeStyle(event) })
          })
        }
      })
      ns.forEach(n => { n.data.incomingTransitions = es.filter(e => e.target === n.id).map(e => ({ event: e.label, source: e.source })) })
      // PCB-style trace stagger
      var pairGroups = {}
      es.forEach(e => { var k = [e.source, e.target].sort().join('|'); if (!pairGroups[k]) pairGroups[k] = []; pairGroups[k].push(e) })
      Object.values(pairGroups).forEach(group => { if (group.length <= 1) return; group.forEach((e, i) => { var y = (i - (group.length - 1) / 2) * 24; e.labelStyle = { ...e.labelStyle, transform: 'translateY(' + y + 'px)' }; e.labelBgStyle = { ...e.labelBgStyle, transform: 'translateY(' + y + 'px)' } }) })
      var sourceGroups = {}
      es.forEach(e => { if (!sourceGroups[e.source]) sourceGroups[e.source] = []; sourceGroups[e.source].push(e) })
      Object.values(sourceGroups).forEach(group => { group.forEach((e, i) => { e.pathOptions = { offset: 15 + i * 20, borderRadius: 8 } }) })
      return { nodes: ns, edges: es }
    }

    function flowToDefinition() {
      const states = {}
      let initial = null
      nodes.value.forEach(node => {
        const d = node.data
        const state = {}
        if (d.isFinal) { state.type = 'final' } else {
          if (d.tools?.length) state.allowed_tools = [...d.tools]
          if (d.instructions) state.instructions = d.instructions
          if (d.maxIterations) state.max_iterations = d.maxIterations
          if (d.maxEditLines) state.max_edit_lines = d.maxEditLines
          if (d.maxFilesPerState) state.max_files_per_state = d.maxFilesPerState
          if (d.allowedCommands?.length) state.allowed_commands = [...d.allowedCommands]
          if (d.contextBudgetBytes) state.context_budget_bytes = d.contextBudgetBytes
          if (d.blockedEnv) state.blocked_env = d.blockedEnv.split(/,\s*/).filter(Boolean)
          if (d.envOverrides) { state.env_overrides = {}; d.envOverrides.split(/,\s*/).filter(Boolean).forEach(pair => { const [k, ...v] = pair.split('='); if (k && v.length) state.env_overrides[k.trim()] = v.join('=').trim() }) }
          const on = {}; edges.value.filter(e => e.source === node.id).forEach(e => { on[e.label || 'NEXT'] = e.target }); if (Object.keys(on).length) state.on = on
        }
        state._position = { x: Math.round(node.position.x), y: Math.round(node.position.y) }
        if (d.isInitial) initial = node.id
        states[node.id] = state
      })
      if (!initial && nodes.value.length) initial = nodes.value[0].id
      return { id: name.value || '', initial: initial || '', states, guards: {} }
    }

    // --- Sync ---
    function syncFlowToJson() { if (syncingFromJson) return; syncingFromFlow = true; const def = flowToDefinition(); jsonText.value = JSON.stringify(def, null, 2); validate(def); saved.value = false; syncingFromFlow = false }
    function syncJsonToFlow() {
      if (syncingFromFlow) return; syncingFromJson = true
      try { const def = JSON.parse(jsonText.value); parseError.value = null; validate(def); const { nodes: n, edges: e } = definitionToFlow(def); nodes.value = n; edges.value = e; const hasPositions = Object.values(def.states || {}).some(s => s._position && (s._position.x || s._position.y)); if (!hasPositions) runLayout() }
      catch (e) { parseError.value = e.message?.split(' at position')[0] || 'Invalid JSON' }
      syncingFromJson = false
    }
    function syncJsonScroll() { if (jsonPre.value && jsonTextarea.value) { jsonPre.value.scrollTop = jsonTextarea.value.scrollTop; jsonPre.value.scrollLeft = jsonTextarea.value.scrollLeft } }
    function onJsonChange() { saved.value = false; syncJsonToFlow() }
    function validate(def) {
      const errors = []
      if (!def.initial) errors.push('No initial state')
      if (!def.states || !Object.keys(def.states).length) errors.push('No states')
      if (def.initial && def.states && !def.states[def.initial]) errors.push(`Initial "${def.initial}" missing`)
      if (def.states) { for (const [sn, sd] of Object.entries(def.states)) { if (sd.on) { for (const [ev, target] of Object.entries(sd.on)) { const t = typeof target === 'string' ? target : target.target; if (t && !def.states[t]) errors.push(`${sn}.${ev} -> "${t}" missing`) } } } }
      validationErrors.value = errors
    }

    // --- Canvas events ---
    function onNodeClick(event) {
      const node = nodes.value.find(n => n.id === event.node.id); const wasOpen = !!selectedNode.value || !!selectedEdge.value; selectedNode.value = node || null; selectedEdge.value = null; editLabel.value = node?.data?.label || ''; updateEdgeHighlights()
      if (node && !wasOpen) { nextTick(() => { const sidebarWidth = 420; const padding = 60; const nodeWidth = 260; const vp = getViewport(); const vpWidth = vpDimensions.value?.width || 800; const nodeScreenRight = (node.position.x + nodeWidth) * vp.zoom + vp.x; const availableWidth = vpWidth - sidebarWidth; if (nodeScreenRight > availableWidth - padding) { const shift = nodeScreenRight - availableWidth + padding + sidebarWidth / 2; setViewport({ x: vp.x - shift, y: vp.y, zoom: vp.zoom }, { duration: 300 }) } }) }
    }
    function onEdgeClick(event) { const edge = edges.value.find(e => e.id === event.edge.id); selectedEdge.value = edge || null; selectedNode.value = null; updateEdgeHighlights() }
    function onPaneClick() { selectedNode.value = null; selectedEdge.value = null; updateEdgeHighlights() }
    function onDragStop() { syncFlowToJson() }
    function onNodesChange(changes) { if (changes.some(c => c.type === 'remove')) { nextTick(() => { if (selectedNode.value && !nodes.value.find(n => n.id === selectedNode.value.id)) selectedNode.value = null; syncFlowToJson() }) } }
    function onEdgesChange(changes) { if (changes.some(c => c.type === 'remove')) { nextTick(() => { if (selectedEdge.value && !edges.value.find(e => e.id === selectedEdge.value.id)) selectedEdge.value = null; syncNodeTransitions(); syncFlowToJson() }) } }
    function syncNodeTransitions() {
      nodes.value = nodes.value.map(n => { const outgoing = n.data.isFinal ? [] : edges.value.filter(e => e.source === n.id).map(e => ({ event: e.label || 'NEXT', target: e.target })); const incoming = edges.value.filter(e => e.target === n.id).map(e => ({ event: e.label || 'NEXT', source: e.source })); return { ...n, data: { ...n.data, transitions: outgoing, incomingTransitions: incoming } } })
      if (selectedNode.value) selectedNode.value = nodes.value.find(n => n.id === selectedNode.value.id) || null
    }
    function updateEdgeHighlights() { const sid = selectedNode.value?.id; edges.value = edges.value.map(e => ({ ...e, class: sid && (e.source === sid || e.target === sid) ? 'connected-to-selected' : '' })) }

    function onConnect(params) {
      if (params.sourceHandle && params.sourceHandle !== 'source-default') {
        const existingEvent = params.sourceHandle.replace('source-', '')
        edges.value = edges.value.filter(e => !(e.source === params.source && e.sourceHandle === params.sourceHandle))
        edges.value.push({ id: `${params.source}-${existingEvent}-${params.target}`, source: params.source, target: params.target, sourceHandle: params.sourceHandle, label: existingEvent, ...edgeStyle(existingEvent) })
        syncNodeTransitions(); updateEdgeHighlights(); syncFlowToJson(); return
      }
      let eventName = 'NEXT'
      const targetNode = nodes.value.find(n => n.id === params.target)
      if (targetNode) { const tl = targetNode.data.label.toLowerCase(); if (tl.includes('fail')) eventName = 'FAIL'; else if (tl.includes('complet') || tl.includes('done') || tl === 'end') eventName = 'DONE'; else if (tl.includes('test')) eventName = 'PASS'; else if (tl.includes('implement')) eventName = 'READY'; else if (tl.includes('escalat')) eventName = 'ESCALATE' }
      connectDialog.value = { source: params.source, target: params.target, eventName }
      nextTick(() => { if (eventNameInput.value) { eventNameInput.value.focus(); eventNameInput.value.select() } })
    }
    function confirmConnect() { if (!connectDialog.value) return; const { source, target, eventName } = connectDialog.value; const ev = eventName || 'NEXT'; edges.value.push({ id: `${source}-${ev}-${target}`, source, target, sourceHandle: `source-${ev}`, targetHandle: `target-${source}-${ev}`, label: ev, ...edgeStyle(ev) }); connectDialog.value = null; syncNodeTransitions(); updateEdgeHighlights(); syncFlowToJson() }
    function cancelConnect() { connectDialog.value = null }

    // --- State management ---
    function addState(type) {
      const baseName = type === 'final' ? 'end' : 'new_state'; let stateName = baseName; let i = 1; while (nodes.value.find(n => n.id === stateName)) stateName = `${baseName}_${i++}`
      const maxY = nodes.value.length ? Math.max(...nodes.value.map(n => n.position.y)) : 0
      const newNode = { id: stateName, type: 'stateNode', position: { x: 200, y: maxY + 160 }, data: { label: stateName, isInitial: nodes.value.length === 0, isFinal: type === 'final', tools: type === 'final' ? [] : ['Read'], instructions: '', maxIterations: type === 'final' ? null : 10, maxEditLines: null, maxFilesPerState: null, allowedCommands: [], contextBudgetBytes: null } }
      nodes.value = [...nodes.value.map(n => ({ ...n, selected: false })), { ...newNode, selected: true }]; selectedNode.value = nodes.value[nodes.value.length - 1]; selectedEdge.value = null; editLabel.value = stateName; updateEdgeHighlights(); syncFlowToJson()
      nextTick(() => { const vp = getViewport(); const vpWidth = vpDimensions.value?.width || 800; const vpHeight = vpDimensions.value?.height || 600; const sidebarWidth = selectedNode.value ? 420 : 0; const availableWidth = vpWidth - sidebarWidth; setViewport({ x: -(newNode.position.x * vp.zoom) + availableWidth / 2, y: -(newNode.position.y * vp.zoom) + vpHeight / 2, zoom: vp.zoom }, { duration: 300 }) })
    }
    function deleteSelected() { if (!selectedNode.value) return; if (!confirm('Delete state "' + selectedNode.value.data.label + '" and all its transitions?')) return; const id = selectedNode.value.id; nodes.value = nodes.value.filter(n => n.id !== id); edges.value = edges.value.filter(e => e.source !== id && e.target !== id); selectedNode.value = null; syncFlowToJson() }
    function removeEdge(edge) { if (!confirm('Remove transition "' + (edge.label || 'NEXT') + '"?')) return; edges.value = edges.value.filter(e => e.id !== edge.id); if (selectedEdge.value?.id === edge.id) selectedEdge.value = null; syncNodeTransitions(); syncFlowToJson() }

    // --- Property editing ---
    function renameNode() { if (!selectedNode.value || !editLabel.value) return; const oldId = selectedNode.value.id; const newId = editLabel.value.trim().replace(/\s+/g, '_'); if (oldId === newId || !newId) return; if (nodes.value.find(n => n.id !== oldId && n.id === newId)) return; edges.value = edges.value.map(e => ({ ...e, source: e.source === oldId ? newId : e.source, target: e.target === oldId ? newId : e.target, id: `${e.source === oldId ? newId : e.source}-${e.label}-${e.target === oldId ? newId : e.target}` })); const idx = nodes.value.findIndex(n => n.id === oldId); if (idx >= 0) { nodes.value = nodes.value.map((n, i) => i === idx ? { ...n, id: newId, data: { ...n.data, label: newId } } : n); selectedNode.value = nodes.value[idx] }; syncFlowToJson() }
    function setInitial() { if (!selectedNode.value) return; nodes.value = nodes.value.map(n => ({ ...n, data: { ...n.data, isInitial: n.id === selectedNode.value.id } })); selectedNode.value = nodes.value.find(n => n.id === selectedNode.value.id); syncFlowToJson() }
    function toggleFinal() { if (!selectedNode.value) return; const isFinal = !selectedNode.value.data.isFinal; const id = selectedNode.value.id; if (isFinal) edges.value = edges.value.filter(e => e.source !== id); nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, isFinal, tools: isFinal ? [] : ['Read'] } } : n); selectedNode.value = nodes.value.find(n => n.id === id); syncFlowToJson() }
    function toggleTool(tool) { if (!selectedNode.value) return; const id = selectedNode.value.id; const tools = [...(selectedNode.value.data.tools || [])]; const idx = tools.indexOf(tool); if (idx >= 0) tools.splice(idx, 1); else tools.push(tool); nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, tools } } : n); selectedNode.value = nodes.value.find(n => n.id === id); syncFlowToJson() }
    function addCustomTool() { if (!customToolName.value || !selectedNode.value) return; const id = selectedNode.value.id; const tools = [...(selectedNode.value.data.tools || []), customToolName.value.trim()]; nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, tools } } : n); selectedNode.value = nodes.value.find(n => n.id === id); customToolName.value = ''; syncFlowToJson() }
    function updateInstruction(val) { if (!selectedNode.value) return; const id = selectedNode.value.id; nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, instructions: val } } : n); selectedNode.value = nodes.value.find(n => n.id === id); syncFlowToJson() }
    function updateGuard(field, val) { if (!selectedNode.value) return; const id = selectedNode.value.id; const numVal = val ? parseInt(val, 10) : null; nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, [field]: numVal } } : n); selectedNode.value = nodes.value.find(n => n.id === id); syncFlowToJson() }
    function addEnvItem(field, event) { const val = event.target.value.trim(); if (!val || !selectedNode.value) return; const current = selectedNode.value.data[field] || ''; const items = current.split(',').map(s => s.trim()).filter(Boolean); items.push(val); const id = selectedNode.value.id; nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, [field]: items.join(', ') } } : n); selectedNode.value = nodes.value.find(n => n.id === id); event.target.value = ''; syncFlowToJson() }
    function removeEnvItem(field, index) { if (!selectedNode.value) return; const items = (selectedNode.value.data[field] || '').split(',').map(s => s.trim()).filter(Boolean); if (!confirm('Remove "' + items[index] + '"?')) return; items.splice(index, 1); const id = selectedNode.value.id; nodes.value = nodes.value.map(n => n.id === id ? { ...n, data: { ...n.data, [field]: items.join(', ') } } : n); selectedNode.value = nodes.value.find(n => n.id === id); syncFlowToJson() }
    function onEdgeLabelChange(edge) { const newLabel = edge.label || 'NEXT'; const style = edgeStyle(newLabel); const newId = `${edge.source}-${newLabel}-${edge.target}`; edges.value = edges.value.map(e => e.id === edge.id ? { ...e, id: newId, label: newLabel, sourceHandle: `source-${newLabel}`, ...style } : e); if (selectedEdge.value?.id === edge.id) selectedEdge.value = edges.value.find(e => e.id === newId); syncNodeTransitions(); syncFlowToJson() }
    function edgeTypeColor(eventName) { const t = edgeType(eventName); if (t === 'happy') return 'bg-green-400'; if (t === 'fail') return 'bg-red-400'; return 'bg-indigo-400' }
    function addTransitionFromSidebar() { if (!selectedNode.value || !newTransitionEvent.value || !newTransitionTarget.value) return; const source = selectedNode.value.id; const target = newTransitionTarget.value; const ev = newTransitionEvent.value.toUpperCase().replace(/\s+/g, '_'); edges.value.push({ id: `${source}-${ev}-${target}`, source, target, sourceHandle: `source-${ev}`, targetHandle: `target-${source}-${ev}`, label: ev, ...edgeStyle(ev) }); newTransitionEvent.value = ''; newTransitionTarget.value = ''; syncNodeTransitions(); updateEdgeHighlights(); syncFlowToJson() }

    // --- Load / Save ---
    async function load() {
      if (workflowId.value === 'new') {
        name.value = ''
        const defaultDef = { id: '', initial: 'planning', states: { planning: { allowed_tools: ['Read', 'Grep', 'Glob'], instructions: 'Understand the problem before making changes.', max_iterations: 8, on: { READY: 'implementing', FAIL: 'failed' } }, implementing: { allowed_tools: ['Read', 'Edit', 'Write'], instructions: 'Make the minimal change needed.', max_iterations: 10, max_edit_lines: 20, on: { DONE: 'testing', FAIL: 'failed' } }, testing: { allowed_tools: ['Read', 'Bash'], instructions: 'Run tests to verify the change.', max_iterations: 5, on: { PASS: 'completed', FAIL_TEST: 'implementing', FAIL: 'failed' } }, completed: { type: 'final' }, failed: { type: 'final' } }, guards: {} }
        jsonText.value = JSON.stringify(defaultDef, null, 2); syncJsonToFlow(); nextTick(runLayout); return
      }
      try { const record = await pocketbase.collection('workflows').getOne(workflowId.value); name.value = record.name; active.value = record.active || false; captureOutput.value = record.definition?.meta?.capture_output || false; jsonText.value = JSON.stringify(record.definition, null, 2); syncJsonToFlow(); const hasPositions = Object.values(record.definition?.states || {}).some(s => s._position && (s._position.x || s._position.y)); if (!hasPositions) nextTick(runLayout) }
      catch (e) { console.error('Failed to load workflow:', e); router.push('/workflows') }
    }

    async function save() {
      saving.value = true; saveError.value = null
      try {
        const definition = JSON.parse(jsonText.value); definition.id = name.value || definition.id
        if (captureOutput.value) { definition.meta = { ...(definition.meta || {}), capture_output: true } } else if (definition.meta) { delete definition.meta.capture_output }
        const data = { name: name.value, definition, active: active.value }
        if (workflowId.value === 'new') { const record = await pocketbase.collection('workflows').create(data); workflowId.value = record.id; router.replace('/workflows/' + record.id) }
        else { await pocketbase.collection('workflows').update(workflowId.value, data) }
        saved.value = true
      } catch (e) { saveError.value = e.message || 'Save failed' }
      saving.value = false
    }

    async function deleteWorkflow() { if (!confirm('Delete workflow "' + name.value + '"? This cannot be undone.')) return; try { await pocketbase.collection('workflows').delete(workflowId.value); router.push('/workflows') } catch (e) { console.error('Failed to delete:', e) } }

    onMounted(() => { load() })

    return {
      workflowId, name, active, captureOutput, saving, saved, saveError, showJson,
      jsonText, parseError, validationErrors,
      nodes, edges, selectedNode, selectedEdge, editLabel,
      connectDialog, toolSearch, customToolName, eventNameInput,
      filteredToolCatalog, selectedNodeTools, selectedNodeEdges,
      highlightedJson, showToolCompendium, compendiumSearch, compendiumSelectedTool, compendiumClient, preferredClient, clientNames, toolInfo, filteredCompendium,
      defaultEdgeOptions, connectionLineStyle,
      onJsonChange, syncJsonScroll, jsonPre, jsonTextarea, onNodeClick, onEdgeClick, onPaneClick,
      onDragStop, onNodesChange, onEdgesChange, onConnect,
      confirmConnect, cancelConnect, addState, deleteSelected,
      removeEdge, renameNode, setInitial, toggleFinal,
      toggleTool, addCustomTool, updateInstruction, updateGuard, addEnvItem, removeEnvItem,
      onEdgeLabelChange, edgeTypeColor, save, deleteWorkflow,
      newTransitionEvent, newTransitionTarget, otherNodes, addTransitionFromSidebar,
    }
  }
}
</script>

<style>
.vue-flow {
  --vf-node-bg: transparent;
  --vf-node-text: #1f2937;
  --vf-connection-path: #6366f1;
  --vf-handle: #6366f1;
}
.vue-flow__handle { transition: transform 0.15s, box-shadow 0.15s; }
.vue-flow__handle:hover { transform: scale(1.4); box-shadow: 0 0 6px rgba(99, 102, 241, 0.5); }
.vue-flow__edge.selected .vue-flow__edge-path { stroke-width: 3; }
.has-selection .vue-flow__node:not(.selected) { opacity: 0.2; transition: opacity 0.25s ease; }
.has-selection .vue-flow__node.selected { opacity: 1; transition: opacity 0.25s ease; }
.has-selection .vue-flow__edge { opacity: 0.1; transition: opacity 0.25s ease; }
.has-selection .vue-flow__edge.connected-to-selected { opacity: 1; transition: opacity 0.25s ease; }
.vue-flow__node, .vue-flow__edge { transition: opacity 0.25s ease; }
.slide-right-enter-active, .slide-right-leave-active { transition: all 0.2s ease; }
.slide-right-enter-from, .slide-right-leave-to { opacity: 0; transform: translateX(20px); }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
.scrollbar-hide::-webkit-scrollbar { display: none; }
.json-editor::selection { background: transparent; }
.json-editor::-moz-selection { background: transparent; }
</style>
