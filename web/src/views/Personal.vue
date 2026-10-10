<script setup lang="ts">
import { ref, watch } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

type PersonalTab = 'farm' | 'bag' | 'task'

const currentTab = ref<PersonalTab>('farm')

const TABS: Array<{ key: PersonalTab, label: string, icon: string }> = [
  { key: 'farm', label: '我的农场', icon: 'i-carbon-sprout' },
  { key: 'bag', label: '我的背包', icon: 'i-carbon-box' },
  { key: 'task', label: '我的任务', icon: 'i-carbon-task' },
]

// 已访问过的页签保持挂载，切回来时保留滚动位置与加载状态。
const visitedTabs = ref<PersonalTab[]>(['farm'])

watch(currentTab, (tab) => {
  if (!visitedTabs.value.includes(tab))
    visitedTabs.value.push(tab)
})
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
        <BagPanel v-else-if="tab === 'bag'" />
        <TaskPanel v-else-if="tab === 'task'" />
      </div>
    </div>
  </div>
</template>
