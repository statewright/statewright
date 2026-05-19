<template>
  <div
    class="state-node rounded-lg shadow-lg border-2 min-w-[200px] max-w-[280px] transition-all duration-150"
    :class="nodeClasses"
  >
    <!-- Top: incoming target ports -->
    <template v-if="data.incomingTransitions?.length">
      <Handle
        v-for="(t, i) in data.incomingTransitions" :key="'t-' + t.source + '-' + t.event"
        type="target"
        :position="Position.Top"
        :id="'target-' + t.source + '-' + t.event"
        class="!w-2.5 !h-2.5 !bg-sky-400 !border-2 !border-gray-300"
        :style="{ left: targetHandleLeft(i, data.incomingTransitions.length) + '%' }"
      />
    </template>
    <Handle v-else
      type="target"
      :position="Position.Top"
      class="!bg-sky-400/50 !border-2 !border-gray-300 !w-2 !h-2"
    />

    <div class="px-3 py-2.5">
      <div class="flex items-center gap-2 mb-1.5">
        <span class="font-bold text-sm" :class="data.isFinal ? 'text-gray-400' : 'text-gray-900'">
          {{ data.label }}
        </span>
        <span v-if="data.isInitial" class="text-[9px] bg-brand-600/80 text-brand-100 px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider">start</span>
        <span v-if="data.isFinal" class="text-[9px] bg-gray-300 text-gray-500 px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider">end</span>
      </div>

      <div v-if="data.tools?.length" class="flex flex-wrap gap-1 mb-1.5">
        <span
          v-for="tool in data.tools"
          :key="tool"
          class="text-[10px] px-1.5 py-0.5 rounded border bg-brand-50 text-brand-700 border-brand-200"
        >{{ tool }}</span>
      </div>

      <div v-if="data.maxIterations || data.maxEditLines || data.maxFilesPerState" class="flex flex-wrap gap-1 mb-1.5">
        <span v-if="data.maxIterations" class="text-[9px] px-1 py-0.5 rounded border bg-yellow-50 text-yellow-700 border-yellow-200">
          {{ data.maxIterations }} iter
        </span>
        <span v-if="data.maxEditLines" class="text-[9px] px-1 py-0.5 rounded border bg-yellow-50 text-yellow-700 border-yellow-200">
          {{ data.maxEditLines }} lines
        </span>
        <span v-if="data.maxFilesPerState" class="text-[9px] px-1 py-0.5 rounded border bg-yellow-50 text-yellow-700 border-yellow-200">
          {{ data.maxFilesPerState }} files
        </span>
      </div>

      <div v-if="data.instructions" class="text-[10px] text-gray-500 truncate">
        {{ data.instructions }}
      </div>
    </div>

    <!-- Bottom: outgoing transition ports -->
    <div v-if="!data.isFinal" class="node-ports flex items-end justify-center gap-6 px-4 pb-2 pt-1 border-t border-gray-200/20">
      <div v-for="t in (data.transitions || [])" :key="t.event" class="port group relative flex flex-col items-center">
        <Handle type="source" :position="Position.Bottom" :id="'source-' + t.event"
          class="!w-2.5 !h-2.5 !border-2 !border-gray-300"
          :class="handleColor(t.event)"
        />
        <div class="absolute top-full mt-1.5 hidden group-hover:block text-[8px] bg-gray-900 text-white px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
          <span :class="labelColor(t.event)">{{ t.event }}</span> → {{ t.target }}
        </div>
      </div>
      <div class="port group relative flex flex-col items-center">
        <Handle type="source" :position="Position.Bottom" id="source-default"
          class="!w-2 !h-2 !bg-gray-400 !border-2 !border-gray-300 hover:!bg-brand-400 transition-colors"
        />
        <div class="absolute top-full mt-1.5 hidden group-hover:block text-[8px] bg-gray-900 text-white px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
          new connection
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'

export default {
  components: { Handle },
  props: ['id', 'data', 'selected'],
  setup(props) {
    const nodeClasses = computed(() => {
      if (props.selected) {
        return 'bg-white border-brand-400 ring-2 ring-brand-400/40 shadow-brand-500/20 shadow-xl'
      }
      if (props.data.isFinal) {
        return 'bg-gray-50 border-gray-300 opacity-80'
      }
      if (props.data.isInitial) {
        return 'bg-white border-brand-500 ring-1 ring-brand-500/20'
      }
      return 'bg-white border-gray-300 hover:border-gray-400'
    })

    const HAPPY = ['DONE', 'PASS', 'READY', 'COMPLETE', 'EXTRACTED', 'VALID', 'TRANSFORMED', 'LOADED', 'READ', 'ANALYZED', 'REPORTED', 'SENT', 'CLASSIFIED']

    function eventType(ev) {
      const u = (ev || '').toUpperCase()
      if (u.includes('FAIL') || u.includes('ERROR')) return 'fail'
      if (HAPPY.includes(u)) return 'happy'
      return 'neutral'
    }

    function handleColor(ev) {
      const t = eventType(ev)
      if (t === 'fail') return '!bg-red-400'
      if (t === 'happy') return '!bg-green-400'
      return '!bg-indigo-400'
    }

    function labelColor(ev) {
      const t = eventType(ev)
      if (t === 'fail') return 'text-red-300'
      if (t === 'happy') return 'text-green-300'
      return 'text-indigo-300'
    }

    function targetHandleLeft(index, total) {
      if (total === 1) return 50
      return 25 + (index / (total - 1)) * 50
    }

    return { Position, nodeClasses, handleColor, labelColor, targetHandleLeft }
  }
}
</script>

<style scoped>
.node-ports .port :deep(.vue-flow__handle) {
  position: relative !important;
  left: auto !important;
  right: auto !important;
  bottom: auto !important;
  top: auto !important;
  transform: none !important;
}
</style>
