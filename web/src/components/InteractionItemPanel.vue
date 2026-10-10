<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import LandCard from '@/components/LandCard.vue'
import { interactionItemTargetReason } from '@/utils/interaction-item-rules'

const props = defineProps<{
  gid: string | number
  lands: any[]
  items: any[]
  loading: boolean
  pending: boolean
}>()

const emit = defineEmits<{
  (e: 'use', itemId: string, landIds: string[]): void
  (e: 'useFarm', itemId: string): void
}>()

const selectedItemId = ref('')
const selectedLandIds = ref<string[]>([])

const landItems = computed(() => (props.items || []).filter(item => item?.targetKind !== 'farm'))
const farmItems = computed(() => (props.items || []).filter(item => item?.targetKind === 'farm'))

const selectedItem = computed(() => landItems.value.find(item => String(item.itemId) === selectedItemId.value) || null)

function landReason(land: any) {
  if (!selectedItemId.value)
    return '请先选择道具'
  return interactionItemTargetReason(selectedItemId.value, land)
}

function isLandAvailable(land: any) {
  return landReason(land) === ''
}

function landKey(land: any) {
  return String(land?.id ?? '')
}

const availableLands = computed(() => (props.lands || []).filter(land => isLandAvailable(land)))

const selectedSet = computed(() => new Set(selectedLandIds.value))

function toggleLand(land: any) {
  const key = landKey(land)
  if (!key || !isLandAvailable(land))
    return
  if (selectedSet.value.has(key)) {
    selectedLandIds.value = selectedLandIds.value.filter(id => id !== key)
  }
  else {
    selectedLandIds.value = [...selectedLandIds.value, key]
  }
}

function selectAllAvailable() {
  selectedLandIds.value = availableLands.value.map(land => landKey(land)).filter(Boolean)
}

function clearSelection() {
  selectedLandIds.value = []
}

function handleUse() {
  if (!selectedItemId.value || selectedLandIds.value.length === 0)
    return
  emit('use', selectedItemId.value, [...selectedLandIds.value])
}

function handleUseFarm(itemId: string) {
  emit('useFarm', itemId)
}

// 道具或土地刷新后，丢掉已经失效的选择，避免提交不存在的地块。
watch(() => [props.gid, props.items], () => {
  const itemIds = new Set((props.items || []).map(item => String(item.itemId)))
  if (selectedItemId.value && !itemIds.has(selectedItemId.value)) {
    selectedItemId.value = ''
  }
  selectedLandIds.value = []
})

watch(selectedItemId, () => {
  selectedLandIds.value = []
})
</script>

<template>
  <div class="mt-3 border border-gray-200 rounded-lg bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-sm text-gray-700 font-medium dark:text-gray-200">
        <div class="i-carbon-flash" />
        <span>互动道具</span>
      </div>
      <div v-if="loading" class="flex items-center gap-1 text-xs text-gray-400">
        <div class="i-svg-spinners-90-ring-with-bg" />
        <span>库存加载中</span>
      </div>
    </div>

    <div v-if="!loading && items.length === 0" class="py-2 text-xs text-gray-400">
      背包中暂无可用于好友农场的特殊互动道具。
    </div>

    <div v-else class="flex flex-col gap-3">
      <div v-if="farmItems.length > 0" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-gray-400">整场道具</span>
        <button
          v-for="item in farmItems"
          :key="item.itemId"
          class="flex items-center gap-1.5 border border-gray-200 rounded-full bg-gray-50 px-3 py-1.5 text-xs text-gray-700 transition dark:border-gray-600 dark:bg-gray-700/40 hover:bg-gray-100 dark:text-gray-200 disabled:opacity-50 dark:hover:bg-gray-700"
          :disabled="pending"
          @click="handleUseFarm(String(item.itemId))"
        >
          <span>{{ item.name }}</span>
          <span class="text-gray-400">×{{ item.count }}</span>
        </button>
      </div>

      <div v-if="landItems.length > 0" class="flex flex-col gap-2">
        <span class="text-xs text-gray-400">土地道具（选道具后点地块，可多选）</span>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="item in landItems"
            :key="item.itemId"
            class="flex items-center gap-1.5 border rounded-full px-3 py-1.5 text-xs transition"
            :class="String(item.itemId) === selectedItemId
              ? 'border-transparent text-white shadow'
              : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700/40 dark:text-gray-200 dark:hover:bg-gray-700'"
            :style="String(item.itemId) === selectedItemId ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="selectedItemId = String(item.itemId)"
          >
            <img v-if="item.image" :src="item.image" class="h-4 w-4 object-contain">
            <span>{{ item.name }}</span>
            <span :class="String(item.itemId) === selectedItemId ? 'text-white/80' : 'text-gray-400'">×{{ item.count }}</span>
          </button>
        </div>
      </div>

      <div v-if="selectedItem" class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <button
            class="border border-gray-200 rounded bg-white px-2.5 py-1 text-gray-600 transition dark:border-gray-600 dark:bg-gray-700/40 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
            :disabled="pending || availableLands.length === 0"
            @click="selectAllAvailable"
          >
            全选可用 ({{ availableLands.length }})
          </button>
          <button
            class="border border-gray-200 rounded bg-white px-2.5 py-1 text-gray-600 transition dark:border-gray-600 dark:bg-gray-700/40 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
            :disabled="pending || selectedLandIds.length === 0"
            @click="clearSelection"
          >
            清空选择
          </button>
          <span class="text-gray-500 dark:text-gray-400">
            已选 {{ selectedLandIds.length }} 块地 · 库存 {{ selectedItem.count }}
          </span>
          <button
            class="rounded px-3 py-1 text-white shadow transition disabled:opacity-50"
            style="background-color: var(--theme-primary)"
            :disabled="pending || selectedLandIds.length === 0"
            @click="handleUse"
          >
            {{ pending ? '使用中…' : `使用 ${selectedLandIds.length} 个` }}
          </button>
        </div>

        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="land in lands"
            :key="landKey(land)"
            class="relative"
          >
            <LandCard
              :land="land"
              :show-actions="false"
              :selected="selectedSet.has(landKey(land))"
              :selection-active="true"
              @select="toggleLand(land)"
            />
            <div
              v-if="!isLandAvailable(land)"
              class="absolute inset-0 flex cursor-not-allowed items-center justify-center rounded-lg bg-gray-900/45 text-xs text-white"
            >
              {{ landReason(land) }}
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="landItems.length > 0" class="text-xs text-gray-400">
        选择一个土地道具后即可点选地块。
      </div>
    </div>
  </div>
</template>
