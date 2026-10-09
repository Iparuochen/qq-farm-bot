<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'
import FriendsInteractionPanel from '@/components/friends/FriendsInteractionPanel.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useToastStore } from '@/stores/toast'

type PersonalTab = 'farm' | 'interaction' | 'bag' | 'task'

const currentTab = ref<PersonalTab>('farm')

const accountStore = useAccountStore()
const farmStore = useFarmStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)
const {
  lands,
  selfInteractionItems,
  selfInteractionItemsLoading,
  selfInteractionUsePending,
} = storeToRefs(farmStore)

const TABS: Array<{ key: PersonalTab, label: string, icon: string }> = [
  { key: 'farm', label: '我的农场', icon: 'i-carbon-sprout' },
  { key: 'interaction', label: '互动道具', icon: 'i-carbon-flash' },
  { key: 'bag', label: '我的背包', icon: 'i-carbon-box' },
  { key: 'task', label: '我的任务', icon: 'i-carbon-task' },
]

// 已访问过的页签保持挂载，切回来时保留滚动位置与加载状态。
const visitedTabs = ref<PersonalTab[]>(['farm'])

watch(currentTab, (tab) => {
  if (!visitedTabs.value.includes(tab))
    visitedTabs.value.push(tab)
})

async function handleUseInteraction(itemId: string, landIds: string[]) {
  if (!currentAccountId.value || !itemId || landIds.length === 0)
    return
  const result: any = await farmStore.useSelfInteractionItemBatch(currentAccountId.value, itemId, landIds)
  if (result?.ok) {
    if (Number(result.failureCount || 0) > 0) {
      toast.warning(result.message || `成功 ${result.successCount} 块，失败 ${result.failureCount} 块`)
    }
    else {
      toast.success(result.message || `已使用 ${result.successCount} 个道具`)
    }
  }
  else {
    toast.error(result?.message || '使用互动道具失败')
  }
}

function loadInteractionItems() {
  if (currentAccountId.value) {
    farmStore.fetchSelfInteractionItems(currentAccountId.value)
  }
}

watch(currentTab, (tab) => {
  if (tab === 'interaction')
    loadInteractionItems()
}, { immediate: true })

const interactionLoading = computed(() => selfInteractionItemsLoading.value || selfInteractionUsePending.value)
</script>

<template>
  <div class="h-full flex flex-col p-4">
    <div class="mb-4 flex flex-wrap gap-2">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === tab.key
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === tab.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = tab.key"
      >
        <div class="flex items-center gap-2">
          <div :class="tab.icon" class="text-lg" />
          <span>{{ tab.label }}</span>
        </div>
      </button>
    </div>

    <div class="flex-1 overflow-hidden overflow-y-auto">
      <div v-for="tab in visitedTabs" v-show="tab === currentTab" :key="tab">
        <FarmPanel v-if="tab === 'farm'" />

        <div v-else-if="tab === 'interaction'" class="p-1">
          <FriendsInteractionPanel
            gid="self"
            :lands="lands"
            :items="selfInteractionItems"
            :loading="interactionLoading"
            :pending="selfInteractionUsePending"
            @use="handleUseInteraction"
          />
        </div>

        <BagPanel v-else-if="tab === 'bag'" />
        <TaskPanel v-else-if="tab === 'task'" />
      </div>
    </div>
  </div>
</template>
