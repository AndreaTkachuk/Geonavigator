<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Map from '@arcgis/core/Map'
import WebMap from '@arcgis/core/WebMap'
import WebScene from '@arcgis/core/WebScene'
import Basemap from '@arcgis/core/Basemap'
import WebTileLayer from '@arcgis/core/layers/WebTileLayer'
import '@arcgis/map-components/dist/components/arcgis-map'
import '@arcgis/map-components/dist/components/arcgis-scene'
import '@arcgis/map-components/dist/components/arcgis-home'
import '@arcgis/map-components/dist/components/arcgis-zoom'
import { useAppStore } from '../../stores/app.store'
import '@arcgis/map-components/dist/components/arcgis-basemap-gallery'
import '@arcgis/map-components/dist/components/arcgis-expand'
import Barrier from '../../components/widgets/Barrier/Barrier.vue'

const props = defineProps<{
  mapType: '2D' | '3D' | null
}>()

const appStore = useAppStore()
const router = useRouter()
const mapEl = ref<any>(null)
const mapIsReady = ref(false)
const mapView = ref<any>(null)
const activeWidget = ref<string | null>(null)
// Widget montati almeno una volta restano nel DOM (v-show) invece di essere distrutti, cosi' non perdono lo stato tra apertura/chiusura del pannello.
const openedWidgetKeys = ref<string[]>([])

function toggleDimension() {
  router.push({ name: is3D.value ? 'map2D' : 'map3D' })
}

function toggleWidget(key: string) {
  if (activeWidget.value === key) {
    activeWidget.value = null
    return
  }
  activeWidget.value = key
  if (!openedWidgetKeys.value.includes(key)) openedWidgetKeys.value.push(key)
  if (!appStore.sidebarOpen) appStore.toggleSidebar()
}

function panelStyle(item: SidebarItem): Record<string, string> {
  const size = item.containerSize
  const style: Record<string, string> = {}
  if (size?.height) style.maxHeight = size.height
  if (size?.width) style.width = size.width
  return style
}

const viewerConfig = computed(() => appStore.currentMapConfig)
const topMenuLinks = computed(
  () => appStore.config?.applicationSettings.topmenu?.links ?? []
)
const is3D = computed(() => (props.mapType ?? viewerConfig.value?.type ?? '2D') === '3D')

// Calcite icon name → MDI class
const ICON_MAP: Record<string, string> = {
  'plus-circle':    'mdi-plus-circle-outline',
  'layers':         'mdi-layers-outline',
  'legend':         'mdi-format-list-bulleted-square',
  'basemap':        'mdi-map-outline',
  'group-items':    'mdi-select-group',
  'annotate-tool':  'mdi-draw',
  'save':           'mdi-content-save-outline',
  'print':          'mdi-printer-outline',
  'tour':           'mdi-map-marker-path',
  'measure':        'mdi-ruler',
  'altitude':       'mdi-chart-bell-curve',
  'bookmark':       'mdi-bookmark-outline',
  'rings-smallest': 'mdi-target',
  'filter':         'mdi-filter-outline',
  'mask-inside':    'mdi-selection',
  'car':            'mdi-car-outline',
  'road-sign':      'mdi-road-variant',
}

interface SidebarItem {
  key: string
  icon: string
  label: string
  separator: boolean
  containerSize?: { width?: string; height?: string }
}

function mdiFor(calcite: string | undefined): string {
  return ICON_MAP[calcite ?? ''] ?? 'mdi-puzzle-outline'
}

const sidebarItems = computed((): SidebarItem[] => {
  const items: SidebarItem[] = []
  const widgets = viewerConfig.value?.widgets ?? []

  for (const w of widgets) {
    if (w.viewGroupCustom) {
      const g = w.viewGroupCustom
      if (!g.visible) continue
      items.push({ key: g.id, icon: mdiFor(g.expandIcon), label: g.expandTooltip ?? g.id, separator: false })
      continue
    }
    if (w.position !== 'aside-position') continue
    if (w.visible === false) continue
    if (!w.expandConfig?.expandTooltip && !w.name) continue
    // skip purely positional widgets (Toggle, About-footer, etc.) that have no expandConfig icon
    if (!w.expandConfig) continue
    const separator = typeof w.customStyle === 'string' && w.customStyle.includes('separator-last')
    items.push({
      key: w.name ?? w.expandConfig.expandTooltip ?? '',
      icon: mdiFor(w.expandConfig.expandIcon),
      label: w.expandConfig.expandTooltip ?? w.name ?? '',
      separator,
      containerSize: w.containerSize,
    })
  }
  return items
})

function resolveMapIdentifier(): string | undefined {
  const targetType = props.mapType ?? viewerConfig.value?.type ?? '2D'
  return viewerConfig.value?.mapId.find((item) => item.type === targetType)?.id
    ?? viewerConfig.value?.mapId[0]?.id
}

function createOsmBasemap(): Basemap {
  return new Basemap({
    baseLayers: [
      new WebTileLayer({
        urlTemplate: 'https://{subDomain}.tile.openstreetmap.org/{level}/{col}/{row}.png',
        subDomains: ['a', 'b', 'c'],
        copyright: '© OpenStreetMap contributors',
      }),
    ],
    title: 'OpenStreetMap',
  })
}

function resolveFallbackBasemap(): Basemap {
  const basemapId = viewerConfig.value?.settings?.basemap
  if (!basemapId || basemapId.toLowerCase() === 'osm') return createOsmBasemap()
  // Id basemap legacy (es. "hybrid", "streets-vector"); i nuovi id stile richiedono una ArcGIS Location Platform API key non configurata qui.
  return Basemap.fromId(basemapId) ?? createOsmBasemap()
}

function resolveMap(): Map {
  const mapId = resolveMapIdentifier()

  const map = mapId
    ? (is3D.value
        ? new WebScene({ portalItem: { id: mapId } })
        : new WebMap({ portalItem: { id: mapId } }))
    : new Map({ basemap: resolveFallbackBasemap() })

  return map
}

let _initId = 0

async function initializeMap(): Promise<void> {
  const myId = ++_initId
  mapIsReady.value = false
  mapView.value = null

  await nextTick() // ensure v-if has swapped arcgis-map ↔ arcgis-scene in DOM

  const el = mapEl.value
  if (!el || myId !== _initId) return

  el.map = resolveMap()

  const settings = viewerConfig.value?.settings
  if (settings?.center) el.center = settings.center
  if (settings?.zoom != null) el.zoom = settings.zoom
  if (!is3D.value && settings?.rotation != null) el.rotation = settings.rotation

  const TIMEOUT_MS = 15_000
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Map load timed out')), TIMEOUT_MS)
  )

  try {
    await Promise.race([el.viewOnReady(), timeout])
    if (myId === _initId) {
      mapIsReady.value = true
      mapView.value = el.view
    }
  } catch (err) {
    if (myId === _initId) console.error('[ViewerPage] Map initialization failed:', err)
  }
}

onMounted(() => { void initializeMap() })

watch(() => props.mapType, () => { void initializeMap() })
watch(() => appStore.currentMapConfig, () => { void initializeMap() })
</script>

<template>
  <div class="viewer-page" :class="{ 'sidebar-open': appStore.sidebarOpen }">
    <header class="viewer-header">
      <div class="brand-block">
        <span class="brand-title">Geonavigatore</span>
        <span class="demo-badge">DEMO</span>
      </div>

      <div class="header-actions">
        <button type="button" class="header-action dim-toggle" @click="toggleDimension">
          <i class="mdi" :class="is3D ? 'mdi-video-2d' : 'mdi-rotate-3d'" />
          <span>{{ is3D ? '2D' : '3D' }}</span>
        </button>
        <a
          v-for="link in topMenuLinks"
          :key="link.label"
          class="header-action"
          :href="link.urlManuale ?? '#'"
          :target="link.urlManuale ? '_blank' : undefined"
          :rel="link.urlManuale ? 'noreferrer' : undefined"
        >
          <i class="mdi" :class="link.icon?.includes('question') ? 'mdi-help-circle-outline' : 'mdi-book-open-variant'" />
          <span>{{ link.label }}</span>
        </a>
      </div>
    </header>

    <section class="viewer-body">
      <aside class="viewer-sidebar" :aria-expanded="appStore.sidebarOpen">
        <ul class="sidebar-list">
          <template v-for="item in sidebarItems" :key="item.key">
            <li
              class="sidebar-item"
              @click="toggleWidget(item.key)"
              :class="{ active: activeWidget === item.key }"
              :title="appStore.sidebarOpen ? undefined : item.label"
            >
              <i class="mdi sidebar-icon" :class="item.icon" />
              <span v-if="appStore.sidebarOpen" class="sidebar-label">{{ item.label }}</span>
              <i
                v-if="appStore.sidebarOpen"
                class="mdi sidebar-chevron"
                :class="activeWidget === item.key ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              />
            </li>
            <li
              v-if="openedWidgetKeys.includes(item.key)"
              v-show="activeWidget === item.key && appStore.sidebarOpen"
              class="accordion-panel"
              :style="panelStyle(item)"
            >
              <div class="widget-content">
                <Barrier v-if="item.key === 'Barrier'" :view="mapView" />
                <!-- Add more widget conditionals as needed -->
                <p v-else style="color: #666; font-size: 0.9em;">Widget: {{ item.key }}</p>
              </div>
            </li>
            <li v-if="item.separator" class="sidebar-separator" aria-hidden="true" />
          </template>
        </ul>

        <button
          type="button"
          class="sidebar-footer"
          :title="appStore.sidebarOpen ? undefined : 'Espandi'"
          @click="appStore.toggleSidebar()"
        >
          <i class="mdi sidebar-icon" :class="appStore.sidebarOpen ? 'mdi-chevron-double-left' : 'mdi-chevron-double-right'" />
          <span v-if="appStore.sidebarOpen" class="sidebar-label">Comprimi</span>
        </button>
      </aside>

      <main class="map-stage">
        <arcgis-map v-if="!is3D" ref="mapEl" class="map-container">
          <arcgis-home slot="top-left" />
          <arcgis-zoom slot="top-left" />
          <arcgis-expand slot="top-right" expand-icon="basemap">
            <arcgis-basemap-gallery />
          </arcgis-expand>
        </arcgis-map>
        <arcgis-scene v-else ref="mapEl" class="map-container">
          <arcgis-home slot="top-left" />
          <arcgis-zoom slot="top-left" />
        </arcgis-scene>

        <div v-if="!mapIsReady" class="map-loading-overlay">
          <div class="map-spinner" />
          <span>Inizializzazione mappa…</span>
        </div>
      </main>
    </section>
  </div>
</template>

<style src="./ViewerPage.css" scoped></style>

<style scoped>
.sidebar-chevron {
  margin-left: auto;
  font-size: 1rem;
  opacity: 0.6;
  flex: 0 0 auto;
}

.accordion-panel {
  max-height: 320px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.03);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  animation: accordion-open 160ms ease;
}

.widget-content {
  padding: 12px 16px;
  border-bottom: 1px solid black;
}

@keyframes accordion-open {
  from { opacity: 0; }
  to { opacity: 1; }
}

.sidebar-item.active {
  background: #f0f0f0;
  border-left: 3px solid #0066cc;
  padding-left: calc(12px - 3px);
}
</style>