<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import Graphic from '@arcgis/core/Graphic'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils'
import { loadRoadData, getNodeKey } from '../utils/roadDataLoader'
import { analyzeDisconnection, type Crossing } from '../utils/roadDisconnectionAnalyzer'

const props = defineProps<{
  view: any
}>()

const emit = defineEmits<{
  ready: []
}>()

// State
const isLoading = ref(true)
const loadError = ref<string | null>(null)
const statusText = ref('Caricamento dati strade...')
const logMessages = ref<string[]>([])
const blockedCount = ref(0)
const disconnectedCount = ref(0)
const isSketchReady = ref(false)
const isDrawing = ref(false)
const isEditingBarrier = ref(false)
const crossingsCount = ref(0)
const isResetConfirming = ref(false)
let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null

// Data
let roadGraph: Map<string, Array<{ neighbor: string; oid: number }>> | null = null
let allFeatures: any[] = []
let crossings: Crossing[] = []

// Layers
let roadsLayer: GeoJSONLayer | null = null
let sketchLayer: GraphicsLayer | null = null
let cutGraphicsLayer: GraphicsLayer | null = null
let cutMarkersLayer: GraphicsLayer | null = null
let sketchVM: SketchViewModel | null = null
const SELECT_CLICK_COOLDOWN_MS = 600

function log(msg: string) {
  logMessages.value.unshift(msg)
  if (logMessages.value.length > 10) logMessages.value.pop()
}

async function loadRoads() {
  try {
    isLoading.value = true
    loadError.value = null
    statusText.value = 'Caricamento dati strade...'

    const basePath = import.meta.env.BASE_URL || '/'
    const roadsPath = `${basePath}data/roads.json`
    const roadData = await loadRoadData(roadsPath)
    roadGraph = roadData.nodeMap
    allFeatures = roadData.features

    statusText.value = `Grafo pronto: ${roadGraph.size} nodi, ${allFeatures.length} strade`
    log(`Grafo costruito: ${roadGraph.size} nodi`)

    isLoading.value = false
    emit('ready')
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Errore sconosciuto'
    loadError.value = msg
    statusText.value = `Errore: ${msg}`
    log(`Errore: ${msg}`)
    isLoading.value = false
  }
}

function initializeLayers() {
  if (!props.view) return

  // Crea le feature collection per la GeoJSONLayer delle strade
  // Converte da paths format ArcGIS a GeoJSON coordinates
  const roadsFeatureCollection = {
    type: 'FeatureCollection',
    features: allFeatures.map((f) => {
      const coordinates = f.geometry.paths.length === 1 
        ? f.geometry.paths[0] 
        : f.geometry.paths

      return {
        type: 'Feature',
        id: f.attributes.OBJECTID,
        properties: {
          OBJECTID: f.attributes.OBJECTID,
          ...Object.keys(f.attributes)
            .filter(k => k !== 'OBJECTID')
            .reduce((acc: any, k) => {
              acc[k] = f.attributes[k]
              return acc
            }, {}),
        },
        geometry: {
          type: f.geometry.paths.length === 1 ? 'LineString' : 'MultiLineString',
          coordinates,
        },
      }
    }),
  }

  const blob = new Blob([JSON.stringify(roadsFeatureCollection)], { type: 'application/json' })
  const blobUrl = URL.createObjectURL(blob)

  roadsLayer = new GeoJSONLayer({
    url: blobUrl,
    outFields: ['*'],
    renderer: {
      type: 'simple' as const,
      symbol: { type: 'simple-line' as const, color: [128, 128, 128], width: 1.5 } as any,
    },
  })

  sketchLayer = new GraphicsLayer({ title: 'Barriere' })
  cutGraphicsLayer = new GraphicsLayer({ title: 'Strade tagliate' })
  cutMarkersLayer = new GraphicsLayer({ title: 'Punti di taglio' })

  props.view.map.addMany([roadsLayer, sketchLayer, cutGraphicsLayer, cutMarkersLayer])

  // Aspetta che il layer sia caricato
  roadsLayer.load().then(async () => {
    // Setup sketch view model
    sketchVM = new SketchViewModel({
      view: props.view,
      layer: sketchLayer,
      // Selezionare una barriera esistente con un click la fa entrare in
      // modalita' di modifica nativa Esri (reshape/move + icona di eliminazione),
      // senza bisogno di un hit-test/listener di click custom.
      updateOnGraphicClick: true,
      defaultUpdateOptions: { tool: 'reshape' } as any,
      polylineSymbol: { type: 'simple-line' as const, color: [255, 165, 0], width: 3, style: 'dash' as const } as any,
    })

    // Il click (o il secondo click di un doppio click) che completa un
    // disegno/spostamento puo' cadere esattamente sulla barriera appena
    // creata/aggiornata: disabilitare temporaneamente updateOnGraphicClick
    // evita che riavvii subito un'altra sessione di update su quello stesso click.
    function suppressGraphicClickBriefly() {
      if (!sketchVM) return
      sketchVM.updateOnGraphicClick = false
      setTimeout(() => {
        if (sketchVM) sketchVM.updateOnGraphicClick = true
      }, SELECT_CLICK_COOLDOWN_MS)
    }

    sketchVM.on('create', (event) => {
      if (event.state === 'complete') {
        isDrawing.value = false
        suppressGraphicClickBriefly()
        recomputeAndApply('Barriera disegnata: ricalcolo...')
      } else if (event.state === 'cancel') {
        isDrawing.value = false
      }
    })

    sketchVM.on('update', (event) => {
      if (event.state === 'start' || event.state === 'active') {
        isEditingBarrier.value = true
      } else if (event.state === 'complete') {
        isEditingBarrier.value = false
        suppressGraphicClickBriefly()
        recomputeAndApply('Barriera spostata: ricalcolo...')
      }
    })

    sketchVM.on('delete', () => {
      isEditingBarrier.value = false
      suppressGraphicClickBriefly()
      recomputeAndApply('Barriera eliminata: ricalcolo...')
    })

    isSketchReady.value = true

    // Zoom to roads extent
    try {
      if (roadsLayer?.fullExtent) {
        await props.view.goTo(roadsLayer.fullExtent)
      }
    } catch (err) {
      console.warn('goTo error:', err)
    }
  }).catch((err) => {
    console.error('Error loading roads layer:', err)
    loadError.value = `Errore caricamento strade: ${err.message}`
  })
}

function touchesNodeKey(polyline: any, targetKey: string): boolean {
  if (!polyline || !polyline.paths || !polyline.paths[0]) return false
  const p = polyline.paths[0]
  const firstKey = getNodeKey(p[0][0], p[0][1])
  const lastKey = getNodeKey(p[p.length - 1][0], p[p.length - 1][1])
  return firstKey === targetKey || lastKey === targetKey
}

// Ricostruisce da zero l'intero array `crossings` a partire da TUTTE le
// geometrie attualmente presenti in sketchLayer (non solo l'ultima disegnata),
// cosi' che spostare o eliminare una barriera si rifletta correttamente
// sull'analisi. Riusa la stessa logica di taglio geometrico gia' esistente,
// applicata in sequenza per ciascuna barriera (una strada viene tagliata dalla
// prima barriera che la interseca, coerente col comportamento precedente).
function rebuildCrossings(): void {
  crossings = []
  crossingsCount.value = 0
  cutMarkersLayer?.removeAll()

  if (!sketchLayer || !roadGraph || !allFeatures.length) return

  const barrierGraphics = sketchLayer.graphics.toArray()

  barrierGraphics.forEach((graphic: any) => {
    let barrierGeometry = graphic.geometry

    try {
      if (webMercatorUtils.canProject(barrierGeometry, { wkid: 4326 })) {
        barrierGeometry = webMercatorUtils.webMercatorToGeographic(barrierGeometry)
      }
    } catch (err) {
      console.warn('Riproiezione barriera non riuscita:', err)
    }

    allFeatures.forEach((f) => {
      const oid = f.attributes.OBJECTID

      if (crossings.some((c) => c.oid === oid)) return

      const roadGeom = f.geometry as any
      if (!geometryEngine.intersects(roadGeom, barrierGeometry)) return

      const parts = geometryEngine.cut(roadGeom, barrierGeometry) as any[]
      if (!parts || parts.length < 2) {
        console.warn(`OID ${oid}: intersects ma cut() non ha prodotto 2+ pezzi`)
        return
      }

      // Type guard for polyline
      if (!roadGeom.paths || !Array.isArray(roadGeom.paths[0])) {
        console.warn(`OID ${oid}: geometry is not a valid polyline`)
        return
      }

      const paths = roadGeom.paths[0]
      const start = getNodeKey(paths[0][0], paths[0][1])
      const end = getNodeKey(paths[paths.length - 1][0], paths[paths.length - 1][1])

      let partStart = parts.find((p: any) => touchesNodeKey(p, start))
      let partEnd = parts.find((p: any) => touchesNodeKey(p, end))

      if (!partStart) partStart = parts[0]
      if (!partEnd) partEnd = parts[parts.length - 1]

      const cutNodeA = `CUT_A_${oid}`
      const cutNodeB = `CUT_B_${oid}`

      crossings.push({ oid, start, end, cutNodeA, cutNodeB, partStart, partEnd })
      crossingsCount.value = crossings.length

      // Marker sul punto di taglio
      const cutPt = (partStart as any).paths[0][(partStart as any).paths[0].length - 1]
      cutMarkersLayer?.add(
        new Graphic({
          geometry: { type: 'point', x: cutPt[0], y: cutPt[1], spatialReference: { wkid: 4326 } } as any,
          symbol: { type: 'simple-marker', color: [0, 0, 0], size: 9, style: 'x' } as any,
        })
      )
    })
  })
}

// Punto d'ingresso comune per creazione, spostamento ed eliminazione di una
// barriera: ricostruisce l'analisi da zero sullo stato attuale delle barriere
// e aggiorna la UI di conseguenza.
function recomputeAndApply(actionMessage: string) {
  log(actionMessage)
  rebuildCrossings()

  if (!sketchLayer || sketchLayer.graphics.length === 0) {
    applyCleanState()
    return
  }

  updateHighlight()
}

function updateHighlight() {
  if (!roadsLayer || !roadGraph) return

  const result = analyzeDisconnection(roadGraph, crossings)
  const { disconnectedOids, disconnectedCutSides, blockedOids } = result

  blockedCount.value = blockedOids.length
  disconnectedCount.value = disconnectedOids.length
  statusText.value = `${blockedOids.length} strada/e tagliata/e: ${disconnectedOids.length} strade disconnesse`

  log(`Analisi: ${blockedOids.length} tagliate, ${disconnectedOids.length} isolate`)

  // Ridisegna i pezzi isolati in rosso
  cutGraphicsLayer?.removeAll()

  crossings.forEach(({ oid, partStart, partEnd }) => {
    const side = disconnectedCutSides.get(oid)
    if (!side) return

    const piecesToColorRed: any[] = []
    if (side === 'A' || side === 'both') piecesToColorRed.push(partStart)
    if (side === 'B' || side === 'both') piecesToColorRed.push(partEnd)

    piecesToColorRed.forEach((piece) => {
      cutGraphicsLayer?.add(
        new Graphic({
          geometry: {
            type: 'polyline' as const,
            paths: piece.paths,
            spatialReference: { wkid: 4326 },
          } as any,
          symbol: { type: 'simple-line' as const, color: [255, 0, 0], width: 4 } as any,
        })
      )
    })
  })

  // Build unique value infos with proper typing
  const disconnectedUnderRoads = disconnectedOids.filter((oid) => !blockedOids.includes(oid))
  
  const infos: any[] = []
  
  // Add completely disconnected roads (red, full line)
  for (const oid of disconnectedUnderRoads) {
    infos.push({
      value: oid,
      symbol: {
        type: 'simple-line',
        color: [255, 0, 0],
        width: 3,
      },
    })
  }

  // Add cut roads (blue, dashed)
  for (const oid of blockedOids) {
    infos.push({
      value: oid,
      symbol: {
        type: 'simple-line',
        color: [0, 0, 255],
        width: 2,
        style: 'dash',
      },
    })
  }

  // Apply renderer
  if (roadsLayer.renderer) {
    roadsLayer.renderer = {
      type: 'unique-value',
      field: 'OBJECTID',
      uniqueValueInfos: infos,
      defaultSymbol: {
        type: 'simple-line',
        color: [128, 128, 128],
        width: 1.5,
      },
    } as any
  }
}

function startDrawing() {
  if (!sketchVM || !isSketchReady.value || isEditingBarrier.value) return

  if (isDrawing.value) {
    sketchVM.cancel?.()
    isDrawing.value = false
    return
  }

  sketchVM.create('polyline')
  isDrawing.value = true
}

// Stato "pulito" equivalente a dopo un Ripristina: usato sia dal bottone
// "Ripristina" (che in aggiunta svuota anche sketchLayer e il log) sia in
// automatico quando l'eliminazione dell'ultima barriera rimasta lascia
// sketchLayer vuoto.
function applyCleanState() {
  cutGraphicsLayer?.removeAll()
  cutMarkersLayer?.removeAll()
  crossings = []
  crossingsCount.value = 0
  blockedCount.value = 0
  disconnectedCount.value = 0
  statusText.value = `Grafo pronto: ${roadGraph?.size ?? 0} nodi, ${allFeatures.length} strade`

  if (roadsLayer) {
    roadsLayer.renderer = {
      type: 'simple' as const,
      symbol: { type: 'simple-line' as const, color: [128, 128, 128], width: 1.5 } as any,
    }
  }
}

function performReset() {
  sketchLayer?.removeAll()
  applyCleanState()
  logMessages.value = []
}

function resetAnalysis() {
  if (crossingsCount.value === 0) return

  if (!isResetConfirming.value) {
    isResetConfirming.value = true
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
    resetConfirmTimer = setTimeout(() => {
      isResetConfirming.value = false
      resetConfirmTimer = null
    }, 4000)
    return
  }

  if (resetConfirmTimer) {
    clearTimeout(resetConfirmTimer)
    resetConfirmTimer = null
  }
  isResetConfirming.value = false
  performReset()
}

onMounted(async () => {
  await loadRoads()
  if (!isLoading.value && !loadError.value) {
    initializeLayers()
  }
})

onUnmounted(() => {
  if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
})
</script>

<template>
  <div class="barrier-widget">
    <!-- Loading / Error State -->
    <div v-if="isLoading" class="widget-loading">
      <div class="spinner" />
      <p>{{ statusText }}</p>
    </div>

    <div v-else-if="loadError" class="widget-error">
      <i class="mdi mdi-alert-circle-outline" />
      <p><strong>Errore:</strong> {{ loadError }}</p>
    </div>

    <!-- Main Widget -->
    <div v-else class="widget-content">
      <div class="widget-status">
        <p class="status-text">{{ statusText }}</p>
        <div v-if="blockedCount > 0 || disconnectedCount > 0" class="stats">
          <div v-if="blockedCount > 0" class="stat-card blocked">
            <i class="mdi mdi-close-octagon-outline stat-icon" />
            <div class="stat-body">
              <span class="stat-value">{{ blockedCount }}</span>
              <span class="stat-label">tagliata/e</span>
            </div>
          </div>
          <div v-if="disconnectedCount > 0" class="stat-card disconnected">
            <i class="mdi mdi-map-marker-off-outline stat-icon" />
            <div class="stat-body">
              <span class="stat-value">{{ disconnectedCount }}</span>
              <span class="stat-label">isolate</span>
            </div>
          </div>
        </div>
      </div>

      <div class="widget-controls">
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!isSketchReady || isEditingBarrier"
          @click="startDrawing"
        >
          <i class="mdi" :class="isDrawing ? 'mdi-close' : 'mdi-pencil'" />
          {{ isDrawing ? 'Annulla disegno' : 'Disegna barriera' }}
        </button>
        <button
          class="btn btn-secondary"
          type="button"
          :class="{ 'btn-warning': isResetConfirming }"
          :disabled="crossingsCount === 0"
          @click="resetAnalysis"
        >
          <i class="mdi" :class="isResetConfirming ? 'mdi-alert-outline' : 'mdi-refresh'" />
          {{ isResetConfirming ? 'Conferma ripristino?' : 'Ripristina' }}
        </button>
      </div>

      <div v-if="!isSketchReady" class="sketch-ready-hint">
        <span class="mini-spinner" />
        Preparazione strumenti di disegno...
      </div>
      <div v-else-if="isEditingBarrier" class="sketch-ready-hint">
        <span class="mini-spinner" />
        Modifica barriera in corso...
      </div>

      <!-- Log Messages -->
      <div v-if="logMessages.length > 0" class="widget-log">
        <div class="widget-log-title">
          <i class="mdi mdi-text-box-outline" />
          Registro operazioni
        </div>
        <div class="log-entries">
          <div v-for="(msg, idx) in logMessages" :key="idx" class="log-entry">
            {{ msg }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.barrier-widget {
  --barrier-primary: #45566b;
  --barrier-primary-deep: #313e4d;
  --barrier-neutral: #8b96a3;
  --barrier-neutral-soft: rgba(139, 150, 163, 0.16);

  background: var(--surface-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text);
}

.widget-loading,
.widget-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  text-align: center;
}

.spinner {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 3px solid var(--barrier-neutral-soft);
  border-top: 3px solid var(--barrier-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 4px;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.widget-error {
  color: var(--text-strong);
}

.widget-error .mdi {
  font-size: 24px;
  color: #b45309;
}

.widget-content {
  padding: 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.widget-status {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.status-text {
  margin: 0;
  font-weight: 600;
  color: var(--text-strong);
}

.stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(17, 32, 25, 0.06);
}

.stat-icon {
  font-size: 20px;
  flex: 0 0 auto;
}

.stat-body {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.stat-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-strong);
}

.stat-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text);
  opacity: 0.8;
}

.stat-card.blocked .stat-icon,
.stat-card.blocked .stat-value {
  color: var(--barrier-primary-deep);
}

.stat-card.disconnected .stat-icon,
.stat-card.disconnected .stat-value {
  color: #c62828;
}

.widget-controls {
  display: flex;
  gap: 8px;
}

.btn {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn-primary {
  background: var(--barrier-primary);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--barrier-primary-deep);
}

.btn-secondary {
  background: var(--surface);
  color: var(--text-strong);
  border-color: var(--line);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--barrier-neutral-soft);
  border-color: var(--barrier-neutral);
}

.btn-secondary.btn-warning {
  background: #fff3cd;
  border-color: #ffc107;
  color: #856404;
}

.btn-secondary.btn-warning:hover:not(:disabled) {
  background: #ffe9a8;
}

.sketch-ready-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text);
  opacity: 0.85;
}

.mini-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--barrier-neutral-soft);
  border-top: 2px solid var(--barrier-neutral);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex: 0 0 auto;
}

.widget-log {
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(17, 32, 25, 0.06);
  overflow: hidden;
}

.widget-log-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-strong);
  border-bottom: 1px solid var(--line);
}

.log-entries {
  max-height: 150px;
  overflow-y: auto;
  padding: 6px 12px;
}

.log-entry {
  font-size: 11px;
  color: var(--text);
  padding: 4px 0;
  border-bottom: 1px solid var(--line);
  font-family: var(--font-mono);
}

.log-entry:last-child {
  border-bottom: none;
}
</style>
