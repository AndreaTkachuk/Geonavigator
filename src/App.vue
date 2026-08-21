<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import esriConfig from '@arcgis/core/config'
import { useAppStore } from './stores/app.store'

const appStore = useAppStore()

const activeError = computed(() => !appStore.config)
const activePreload = computed(() => appStore.isLoading)

if (appStore.portalUrl) {
  esriConfig.portalUrl = appStore.portalUrl
}

watch(
  () => appStore.portalUrl,
  (url) => {
    if (url) esriConfig.portalUrl = url
  }
)

function onResize(): void {
  appStore.setMobile(window.outerWidth < 768)
}

onMounted(() => {
  window.addEventListener('resize', onResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div id="app-root">
    <div
      v-if="activePreload"
      class="preload-overlay"
      :style="{ backgroundColor: appStore.preloadBackground }"
    >
      <div class="preload-spinner" />
    </div>

    <div v-else-if="activeError" class="error-display">
      <h2>Errore di configurazione</h2>
      <p>Impossibile caricare la configurazione dell'applicazione.</p>
    </div>

    <template v-else>
      <RouterView />
    </template>
  </div>
</template>

<style scoped>
#app-root {
  width: 100%;
  height: 100vh;
  overflow: hidden;
  position: relative;
}

.preload-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.preload-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  font-family: Arial, sans-serif;
  background: #f5f5f5;
  color: #333;
}
</style>