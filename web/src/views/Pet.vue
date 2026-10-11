<script setup lang="ts">
// 宠物页：内容与个人页「宠物」页签共用上游 PetPanel，保持菜单入口不变。
import PetPanel from '@/components/PetPanel.vue'
</script>

<template>
  <div class="h-full flex flex-col p-4">
    <div class="flex-1 overflow-hidden overflow-y-auto">
      <PetPanel />
    </div>
  </div>
</template>
