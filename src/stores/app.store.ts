import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AppConfig, ViewerConfig } from './router/types/config.types'

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig | null>(null)
  const isMobile = ref<boolean>(false)
  const isLoading = ref<boolean>(false)
  const isLoggedIn = ref<boolean>(false)
  const sidebarOpen = ref<boolean>(true)

  const activeLogin = computed(
    () => config.value?.applicationSettings?.login?.active ?? false
  )

  const loggedIn = computed(
    () => !activeLogin.value || isLoggedIn.value
  )

  const debug = computed(
    () => config.value?.debug ?? false
  )

  const portalUrl = computed(
    () => config.value?.applicationSettings?.portalUrl ?? ''
  )

  const preloadBackground = computed(
    () => config.value?.applicationSettings?.preload?.background ?? '#297a38'
  )

  const currentMapConfig = computed((): ViewerConfig | null => {
    if (!config.value?.map) return null
    return isMobile.value
      ? config.value.map.viewerMobile
      : config.value.map.viewer
  })

  function setConfig(newConfig: AppConfig): void {
    config.value = newConfig
    if (debug.value) {
      console.log('[AppStore] Config loaded:', newConfig)
    }
  }

  function setMobile(mobile: boolean): void {
    isMobile.value = mobile
  }

  function setLoading(loading: boolean): void {
    isLoading.value = loading
  }

  function setLoggedIn(logged: boolean): void {
    isLoggedIn.value = logged
  }

  function setSidebarOpen(open: boolean): void {
    sidebarOpen.value = open
  }

  function toggleSidebar(): void {
    sidebarOpen.value = !sidebarOpen.value
  }

  return {
    config,
    isMobile,
    isLoading,
    isLoggedIn,
    sidebarOpen,
    activeLogin,
    loggedIn,
    debug,
    portalUrl,
    preloadBackground,
    currentMapConfig,
    setConfig,
    setMobile,
    setLoading,
    setLoggedIn,
    setSidebarOpen,
    toggleSidebar,
  }
})