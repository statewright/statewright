<script setup>
import { computed } from 'vue'
import { getBezierPath, BaseEdge, EdgeLabelRenderer } from '@vue-flow/core'

const props = defineProps({
  id: String,
  sourceX: Number,
  sourceY: Number,
  targetX: Number,
  targetY: Number,
  sourcePosition: String,
  targetPosition: String,
  style: Object,
  markerEnd: String,
  label: String,
  labelStyle: Object,
  labelBgStyle: Object,
  labelBgPadding: Array,
  labelBgBorderRadius: Number,
  data: Object,
  animated: Boolean,
})

const pathData = computed(() => {
  const offset = props.data?.offset || 0

  const isBackEdge = props.sourceY > props.targetY
  const absOffset = Math.abs(offset)

  if (isBackEdge) {
    const midX = Math.min(props.sourceX, props.targetX) - absOffset - 60
    const midY = (props.sourceY + props.targetY) / 2
    const path = `M ${props.sourceX} ${props.sourceY} C ${midX} ${props.sourceY}, ${midX} ${props.targetY}, ${props.targetX} ${props.targetY}`
    return { path, labelX: midX + 30, labelY: midY }
  }

  const curvature = 0.25 + absOffset * 0.1
  const dx = props.targetX - props.sourceX
  const dy = props.targetY - props.sourceY
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const perpX = (-dy / len) * offset * 0.4
  const perpY = (dx / len) * offset * 0.4

  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX + perpX,
    sourceY: props.sourceY + perpY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX + perpX,
    targetY: props.targetY + perpY,
    targetPosition: props.targetPosition,
    curvature,
  })

  return { path, labelX: labelX + perpX * 0.5, labelY: labelY + perpY * 0.5 }
})
</script>

<template>
  <BaseEdge
    :id="id"
    :path="pathData.path"
    :style="style"
    :marker-end="markerEnd"
    :class="{ animated }"
  />
  <EdgeLabelRenderer v-if="label">
    <div
      :style="{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${pathData.labelX}px, ${pathData.labelY}px)`,
        pointerEvents: 'all',
      }"
      class="nodrag nopan"
    >
      <span
        :style="{
          ...labelBgStyle,
          padding: labelBgPadding ? `${labelBgPadding[1]}px ${labelBgPadding[0]}px` : '3px 5px',
          borderRadius: `${labelBgBorderRadius || 3}px`,
          display: 'inline-block',
        }"
      >
        <span :style="labelStyle">{{ label }}</span>
      </span>
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
.animated path {
  stroke-dasharray: 5;
  animation: dash 0.5s linear infinite;
}
@keyframes dash {
  to { stroke-dashoffset: -10; }
}
</style>
