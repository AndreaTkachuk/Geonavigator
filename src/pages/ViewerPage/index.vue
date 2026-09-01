<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Map from '@arcgis/core/Map'
import WebMap from '@arcgis/core/WebMap'
import Basemap from '@arcgis/core/Basemap'
import WebTileLayer from '@arcgis/core/layers/WebTileLayer'
import '@arcgis/map-components/dist/components/arcgis-map'
import '@arcgis/map-components/dist/components/arcgis-home'
import '@arcgis/map-components/dist/components/arcgis-zoom'
import { useAppStore } from '../../stores/app.store'
import '@arcgis/map-components/dist/components/arcgis-basemap-gallery'
import '@arcgis/map-components/dist/components/arcgis-expand'
// Caricati solo quando il relativo pannello viene aperto per la prima volta: Barrier da solo porta con se'
// SketchViewModel/GraphicsLayer/GeoJSONLayer/geometryEngine/webMercatorUtils, che altrimenti finiscono nel
// bundle iniziale della pagina anche se l'utente non apre mai quel pannello.
const Barrier = defineAsyncComponent(() => import('../../components/widgets/Barrier/Barrier.vue'))
const BarrierResults = defineAsyncComponent(() => import('../../components/widgets/BarrierResults/BarrierResults.vue'))

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
// BarrierResults vive in un cassetto (drawer) che scorre dal basso, non nella lista accordion della sidebar.
const bottomDrawerOpen = ref(false)

function toggleBottomDrawer() {
  bottomDrawerOpen.value = !bottomDrawerOpen.value
}

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

const ACCORDION_PANEL_TRANSITION_MS = 420
const ACCORDION_PANEL_DEFAULT_MAX_HEIGHT_PX = 320

function panelMaxHeightPx(item: SidebarItem): number {
  const configured = item.containerSize?.height
  const parsed = configured ? parseFloat(configured) : NaN
  return Number.isNaN(parsed) ? ACCORDION_PANEL_DEFAULT_MAX_HEIGHT_PX : parsed
}

// Transizione dell'apertura/chiusura del pannello guidata via JS (altezza reale del contenuto, non un
// max-height fisso) cosi' l'animazione resta fluida qualunque sia la lunghezza del contenuto. Il widget
// dentro il pannello resta montato (v-show, non v-if): Transition supporta v-show senza distruggerlo.
function onAccordionPanelEnter(el: Element, item: SidebarItem) {
  const panel = el as HTMLElement
  const targetHeight = Math.min(panel.scrollHeight, panelMaxHeightPx(item))
  panel.style.height = '0px'
  panel.style.overflow = 'hidden'
  void panel.offsetHeight // forza il reflow: senza, il browser fonde le due modifiche e la transizione non parte
  panel.style.transition = `height ${ACCORDION_PANEL_TRANSITION_MS}ms ease`
  panel.style.height = `${targetHeight}px`
}

function onAccordionPanelAfterEnter(el: Element) {
  const panel = el as HTMLElement
  panel.style.height = ''
  panel.style.overflow = ''
  panel.style.transition = ''
}

function onAccordionPanelLeave(el: Element) {
  const panel = el as HTMLElement
  panel.style.height = `${panel.scrollHeight}px`
  panel.style.overflow = 'hidden'
  void panel.offsetHeight
  panel.style.transition = `height ${ACCORDION_PANEL_TRANSITION_MS}ms ease`
  panel.style.height = '0px'
}

// Stessa tecnica dell'accordion della sidebar (altezza reale via JS, non v-if istantaneo), applicata al
// contenuto del cassetto in fondo alla mappa: l'header che fa da pulsante resta fisso, solo il contenuto
// sotto si apre/chiude in altezza.
const BOTTOM_DRAWER_CONTENT_MAX_HEIGHT_PX = 360

function onDrawerContentEnter(el: Element) {
  const content = el as HTMLElement
  const targetHeight = Math.min(content.scrollHeight, BOTTOM_DRAWER_CONTENT_MAX_HEIGHT_PX)
  content.style.height = '0px'
  content.style.overflow = 'hidden'
  void content.offsetHeight
  content.style.transition = `height ${ACCORDION_PANEL_TRANSITION_MS}ms ease`
  content.style.height = `${targetHeight}px`
}

function onDrawerContentAfterEnter(el: Element) {
  const content = el as HTMLElement
  content.style.height = ''
  content.style.overflow = ''
  content.style.transition = ''
}

function onDrawerContentLeave(el: Element) {
  const content = el as HTMLElement
  content.style.height = `${content.scrollHeight}px`
  content.style.overflow = 'hidden'
  void content.offsetHeight
  content.style.transition = `height ${ACCORDION_PANEL_TRANSITION_MS}ms ease`
  content.style.height = '0px'
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

// La 3D (WebScene + il custom element arcgis-scene) porta con se' un motore di rendering 3D pesante
// (I3S, video layer, symbol layer 3D, ecc.): la carichiamo solo al bisogno, non nel bundle iniziale,
// dato che la configurazione di default e' sempre 2D. Il caricamento del custom element va tenuto
// legato SOLO a is3D (viene renderizzato <arcgis-scene> comunque), non alla presenza di un mapId:
// altrimenti, senza un portalItem configurato (fallback su Map+basemap), l'elemento non verrebbe
// mai registrato e l'app fallirebbe con "viewOnReady is not a function".
async function resolveMap(): Promise<Map> {
  const mapId = resolveMapIdentifier()

  if (is3D.value) {
    const sceneComponentReady = Promise.all([
      import('@arcgis/map-components/dist/components/arcgis-scene'),
      customElements.whenDefined('arcgis-scene'),
    ])

    if (!mapId) {
      await sceneComponentReady
      return new Map({ basemap: resolveFallbackBasemap() })
    }

    const [{ default: WebScene }] = await Promise.all([import('@arcgis/core/WebScene'), sceneComponentReady])
    return new WebScene({ portalItem: { id: mapId } })
  }

  if (!mapId) return new Map({ basemap: resolveFallbackBasemap() })
  return new WebMap({ portalItem: { id: mapId } })
}

let _initId = 0

async function initializeMap(): Promise<void> {
  const myId = ++_initId
  mapIsReady.value = false
  mapView.value = null

  const map = await resolveMap()
  if (myId !== _initId) return

  await nextTick() // ensure v-if has swapped arcgis-map ↔ arcgis-scene in DOM

  const el = mapEl.value
  if (!el || myId !== _initId) return

  el.map = map

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
            <Transition
              name="accordion-panel"
              @enter="(el) => onAccordionPanelEnter(el, item)"
              @after-enter="onAccordionPanelAfterEnter"
              @leave="onAccordionPanelLeave"
            >
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
            </Transition>
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

        <div class="bottom-drawer-backdrop" :class="{ open: bottomDrawerOpen }" @click="bottomDrawerOpen = false" />

        <!-- L'header e' sempre alla stessa posizione (in fondo alla mappa) e funge lui stesso da pulsante:
             niente pulsante separato che "galleggia" e si sposta quando il pannello si apre. -->
        <section class="bottom-drawer">
          <button
            type="button"
            class="bottom-drawer-header"
            :aria-expanded="bottomDrawerOpen"
            @click="toggleBottomDrawer"
          >
            <i class="mdi mdi-format-list-bulleted-square me-2" />
            <span>Risultati analisi barriere</span>
            <i class="mdi bottom-drawer-chevron" :class="bottomDrawerOpen ? 'mdi-chevron-down' : 'mdi-chevron-up'" />
          </button>

          <Transition
            name="bottom-drawer-content"
            @enter="onDrawerContentEnter"
            @after-enter="onDrawerContentAfterEnter"
            @leave="onDrawerContentLeave"
          >
            <div v-if="bottomDrawerOpen" class="bottom-drawer-content">
              <BarrierResults />
            </div>
          </Transition>
        </section>
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

.bottom-drawer-backdrop {
  position: absolute;
  inset: 0;
  z-index: 55;
  background: rgba(0, 0, 0, 0.25);
  opacity: 0;
  pointer-events: none;
  transition: opacity 420ms ease;
}

.bottom-drawer-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

/* L'header resta sempre nella stessa posizione e fa lui stesso da pulsante: nessun elemento separato
   che si sposta sopra la mappa. Solo bottom-drawer-content si apre/chiude sotto di esso. */
.bottom-drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 58;
  display: flex;
  flex-direction: column;
  background: var(--surface-strong, #fff);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
}

.bottom-drawer-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-top: 1px solid var(--line);
  background: var(--surface-strong, #fff);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-strong);
  cursor: pointer;
  flex: 0 0 auto;
  width: 100%;
  text-align: left;
}

.bottom-drawer-header:hover {
  background: rgba(17, 32, 25, 0.05);
}

.bottom-drawer-chevron {
  margin-left: auto;
  font-size: 1.1rem;
  opacity: 0.6;
}

.bottom-drawer-content {
  overflow-y: auto;
  flex: 0 0 auto;
}
</style>