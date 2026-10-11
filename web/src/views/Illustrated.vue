<script setup lang="ts">
// 图鉴页：内容与个人页「图鉴」页签共用上游 IllustratedPanel，保持菜单入口不变。
import IllustratedPanel from '@/components/IllustratedPanel.vue'
</script>

<template>
  <div class="h-full flex flex-col p-4">
    <div class="flex-1 overflow-hidden overflow-y-auto">
      <IllustratedPanel />
    </div>
  </div>
</template>
