import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './stores/router/index'
import { useAppStore } from './stores/app.store.ts'
import type { AppConfig } from './stores/router/types/config.types'
import { loadFonts } from 'bootstrap-italia'
import './style.css'
import '@arcgis/core/assets/esri/themes/light/main.css'
import '@mdi/font/css/materialdesignicons.css'
import 'bootstrap-italia/dist/css/bootstrap-italia.min.css'

loadFonts(`${import.meta.env.BASE_URL}fonts/bootstrap-italia`)

// Carica la configurazione prima dell'avvio dell'app Vue.
async function loadConfig(): Promise<AppConfig | null> {
  const urlParams = new URLSearchParams(window.location.search)
  const configParam = urlParams.get('config')

  const configUrl = configParam?.startsWith('http')
    ? configParam
    : new URL(`./assets/configs/${configParam ?? 'config.json'}`, import.meta.url).href

  try {
    const res = await fetch(configUrl, {
      method: 'GET',
      cache: 'no-cache',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return null
    const rawConfig = await res.text()
    const normalizedConfig = rawConfig.replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(normalizedConfig) as AppConfig
  } catch {
    return null
  }
}

// Rileva dispositivi mobili e viewport stretti.
function detectDevice(): boolean {
  const mobileRegex =
    /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|ipad|iris|kindle|lge |maemo|midp|mmp|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i

  if (mobileRegex.test(navigator.userAgent)) return true
  if (window.outerWidth < 768) return true
  return false
}

// Applica gli attributi del tema sul tag <html>.
function applyTheme(themes: Record<string, string>): void {
  const html = document.querySelector('html')
  if (!html) return
  for (const [attr, value] of Object.entries(themes)) {
    if (typeof value === 'string') {
      html.setAttribute(attr, value)
    }
  }
}

// Mostra un messaggio semplice se la configurazione non è disponibile.
function showConfigError(): void {
  const lang = localStorage.getItem('language') || 'it'
  const messages: Record<string, { title: string; message: string }> = {
    it: {
      title: 'Configurazione non trovata',
      message: 'Il file di configurazione non esiste o non è raggiungibile.',
    },
    en: {
      title: 'Configuration not found',
      message: 'The configuration file does not exist or is not reachable.',
    },
  }
  const t = messages[lang] ?? messages['en']

  document.body.innerHTML = `
    <div style="
      display:flex; align-items:center; justify-content:center;
      height:100vh; flex-direction:column; font-family:Arial; background:#f5f5f5;
    ">
      <h1>${t.title}</h1>
      <p>${t.message}</p>
    </div>
  `
}

async function bootstrap() {
  const app = createApp(App)
  const pinia = createPinia()

  app.use(pinia)
  app.use(router)

  const appStore = useAppStore()
  appStore.setLoading(true)

  const config = await loadConfig()

  if (!config) {
    showConfigError()
    return
  }

  document.title = config.applicationSettings.titlePage ?? 'Geoportale'

  if (config.themes) {
    applyTheme(config.themes)
  }

  appStore.setConfig(config)
  appStore.setMobile(detectDevice())
  appStore.setSidebarOpen(!appStore.isMobile)
  appStore.setLoading(false)

  app.mount('#app')
}

bootstrap()