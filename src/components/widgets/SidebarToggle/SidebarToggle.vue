<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../../stores/app.store'

const appStore = useAppStore()

const toggleLabel = computed(() => (appStore.sidebarOpen ? 'Riduci' : 'Espandi'))
</script>

<template>
  <button
    class="sidebar-toggle"
    type="button"
    :aria-label="toggleLabel"
    :title="toggleLabel"
    @click="appStore.toggleSidebar()"
  >
    <i class="mdi" :class="appStore.sidebarOpen ? 'mdi-chevron-left' : 'mdi-chevron-right'" />
  </button>
</template>

<style src="./SidebarToggle.css" scoped></style>