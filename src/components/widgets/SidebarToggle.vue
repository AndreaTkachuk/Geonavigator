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

<style scoped>
.sidebar-toggle {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 14px;
  color: white;
  background: linear-gradient(180deg, var(--accent) 0%, var(--accent-deep) 100%);
  box-shadow: 0 10px 20px rgba(41, 122, 56, 0.25);
}

.sidebar-toggle i {
  font-size: 1.2rem;
}
</style>