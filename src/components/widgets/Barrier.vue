<!-- <script setup lang="ts">
import '@arcgis/map-components/dist/components/arcgis-sketch'

defineProps<{
  view?: any
}>()

function onCreate(event: any) {
  console.log('[Barrier] arcgisCreate', event.detail.state, event.detail.graphic)
}
</script>

<template>
  <div class="barrier-panel">
    <h3>Analisi isolamento stradale</h3>
    <arcgis-sketch v-if="view" :view="view" @arcgisCreate="onCreate" />
  </div>
</template>

<style scoped>
.barrier-panel {
  /* padding: 26px; */
  background: white;
}
</style> -->




<script setup lang="ts">
import { onMounted, ref } from 'vue'
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

// Data
let roadGraph: Map<string, Array<{ neighbor: string; oid: number }>> | null = null
let allFeatures: any[] = []
let crossings: Crossing[] = []

// Layers
let roadsLayer: GeoJSONLayer | null = null
let sketchLayer: GraphicsLayer | null = null
let cutGraphicsLayer: GraphicsLayer | null = null
let sketchVM: SketchViewModel | null = null

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

  props.view.map.addMany([roadsLayer, sketchLayer, cutGraphicsLayer])

  // Aspetta che il layer sia caricato
  roadsLayer.load().then(async () => {
    // Setup sketch view model
    sketchVM = new SketchViewModel({
      view: props.view,
      layer: sketchLayer,
      polylineSymbol: { type: 'simple-line' as const, color: [255, 165, 0], width: 3, style: 'dash' as const } as any,
    })

    sketchVM.on('create', (event) => {
      if (event.state === 'complete') {
        handleBarrierDrawn(event.graphic?.geometry)
      }
    })

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

function handleBarrierDrawn(rawBarrierGeometry: any) {
  if (!roadGraph || !allFeatures.length) {
    log('Grafo non ancora pronto')
    return
  }

  let barrierGeometry = rawBarrierGeometry

  try {
    if (webMercatorUtils.canProject(rawBarrierGeometry, { wkid: 4326 })) {
      barrierGeometry = webMercatorUtils.webMercatorToGeographic(rawBarrierGeometry)
    }
  } catch (err) {
    console.warn('Riproiezione barriera non riuscita:', err)
  }

  let crossedCount = 0

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
    crossedCount++

    // Marker sul punto di taglio
    const cutPt = (partStart as any).paths[0][(partStart as any).paths[0].length - 1]
    sketchLayer?.add(
      new Graphic({
        geometry: { type: 'point', x: cutPt[0], y: cutPt[1], spatialReference: { wkid: 4326 } } as any,
        symbol: { type: 'simple-marker', color: [0, 0, 0], size: 9, style: 'x' } as any,
      })
    )
  })

  if (crossedCount === 0) {
    log('Nessuna nuova strada tagliata')
    return
  }

  log(`Barriera disegnata: ${crossedCount} strada/e tagliata/e`)
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
  if (sketchVM) {
    sketchVM.create('polyline')
  }
}

function resetAnalysis() {
  sketchLayer?.removeAll()
  cutGraphicsLayer?.removeAll()
  crossings = []
  logMessages.value = []
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

onMounted(async () => {
  await loadRoads()
  if (!isLoading.value && !loadError.value) {
    initializeLayers()
  }
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
      <p><strong>Errore:</strong> {{ loadError }}</p>
    </div>

    <!-- Main Widget -->
    <div v-else class="widget-content">
      <div class="widget-status">
        <p class="status-text">{{ statusText }}</p>
        <div class="stats">
          <span v-if="blockedCount > 0" class="stat-item blocked">
            🚫 {{ blockedCount }} tagliata/e
          </span>
          <span v-if="disconnectedCount > 0" class="stat-item disconnected">
            ❌ {{ disconnectedCount }} isolate
          </span>
        </div>
      </div>

      <div class="widget-controls">
        <button class="btn btn-primary" @click="startDrawing">
          <i class="mdi mdi-pencil" /> Disegna barriera
        </button>
        <button class="btn btn-secondary" @click="resetAnalysis">
          <i class="mdi mdi-refresh" /> Ripristina
        </button>
      </div>

      <!-- Log Messages -->
      <div v-if="logMessages.length > 0" class="widget-log">
        <div v-for="(msg, idx) in logMessages" :key="idx" class="log-entry">
          {{ msg }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.barrier-widget {
  background: white;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: #333;
}

.widget-loading,
.widget-error {
  padding: 20px;
  text-align: center;
}

.spinner {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 3px solid #f3f3f3;
  border-top: 3px solid #0066cc;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 12px;
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
  background: #fff3cd;
  border: 1px solid #ffc107;
  border-radius: 4px;
  color: #856404;
}

.widget-content {
  padding: 16px;
}

.widget-status {
  margin-bottom: 16px;
}

.status-text {
  margin: 0 0 8px 0;
  font-weight: 600;
  color: #333;
}

.stats {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.stat-item {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
}

.stat-item.blocked {
  background: #e3f2fd;
  color: #1565c0;
}

.stat-item.disconnected {
  background: #ffebee;
  color: #c62828;
}

.widget-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.btn {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.2s;
}

.btn-primary {
  background: #0066cc;
  color: white;
}

.btn-primary:hover {
  background: #0052a3;
}

.btn-secondary {
  background: #f0f0f0;
  color: #333;
  border: 1px solid #ddd;
}

.btn-secondary:hover {
  background: #e0e0e0;
}

.widget-log {
  max-height: 150px;
  overflow-y: auto;
  background: #f9f9f9;
  border: 1px solid #eee;
  border-radius: 3px;
  padding: 8px;
}

.log-entry {
  font-size: 11px;
  color: #666;
  padding: 4px 0;
  border-bottom: 1px solid #f0f0f0;
  font-family: 'Monaco', 'Courier New', monospace;
}

.log-entry:last-child {
  border-bottom: none;
}

.mdi {
  width: 16px;
  height: 16px;
}
</style>
