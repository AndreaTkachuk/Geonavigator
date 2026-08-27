<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import Graphic from '@arcgis/core/Graphic'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils'
import { loadRoadData, getNodeKey } from '../../utils/roadDataLoader'
import {
  analyzeDisconnection,
  type Crossing,
  type DisconnectionResult,
} from '../../utils/roadDisconnectionAnalyzer'

interface BarrierSummary {
  id: string
  label: string
  cutCount: number
  isolatedCount: number
}

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
const barriers = ref<BarrierSummary[]>([])
let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null

// Data
let roadGraph: Map<string, Array<{ neighbor: string; oid: number }>> | null = null
let allFeatures: any[] = []
let crossings: Crossing[] = []
// Contatore progressivo per id/etichetta delle barriere: non si riassegna mai, cosi' eliminarne una in mezzo alla lista non rinumera le altre.
let nextBarrierNumber = 1

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

// Disabilita temporaneamente updateOnGraphicClick: il click che completa un disegno/spostamento puo' cadere sulla barriera appena creata e riavviare subito un'altra sessione di update.
function suppressGraphicClickBriefly() {
  if (!sketchVM) return
  sketchVM.updateOnGraphicClick = false
  setTimeout(() => {
    if (sketchVM) sketchVM.updateOnGraphicClick = true
  }, SELECT_CLICK_COOLDOWN_MS)
}

// Esce da un'eventuale sessione di disegno/modifica attiva prima di mutare i graphics dall'esterno, per non lasciare overlay disallineati con lo stato/camera successivo.
function cancelActiveSketchSession() {
  sketchVM?.cancel()
  isDrawing.value = false
  isEditingBarrier.value = false
}

async function loadRoads() {
  try {
    isLoading.value = true
    loadError.value = null
    statusText.value = 'Caricamento dati strade...'

    const roadData = await loadRoadData()
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

  // Converte le features da formato paths ArcGIS a GeoJSON per la GeoJSONLayer delle strade.
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

  // elevationInfo 'on-the-ground' clampa la barriera al terreno: niente maniglia verticale in 3D, l'altezza segue sempre la superficie.
  sketchLayer = new GraphicsLayer({ title: 'Barriere', elevationInfo: { mode: 'on-the-ground' } as any })
  cutGraphicsLayer = new GraphicsLayer({ title: 'Strade tagliate' })
  cutMarkersLayer = new GraphicsLayer({ title: 'Punti di taglio' })

  props.view.map.addMany([roadsLayer, sketchLayer, cutGraphicsLayer, cutMarkersLayer])

  // Aspetta che il layer sia caricato
  roadsLayer.load().then(async () => {
    // Setup sketch view model
    sketchVM = new SketchViewModel({
      view: props.view,
      layer: sketchLayer,
      // Click su barriera esistente attiva editing nativo Esri (reshape/move + eliminazione), senza hit-test/listener custom.
      updateOnGraphicClick: true,
      // reshapeOptions e' "only supported in 3D, partially in 2D": applicarlo anche in 2D romperebbe il semplice spostamento dei vertici.
      defaultUpdateOptions: (props.view?.type === '3d'
        ? { tool: 'reshape', reshapeOptions: { edgeOperation: 'none', vertexOperation: 'move' } }
        : { tool: 'reshape' }) as any,
      polylineSymbol: { type: 'simple-line' as const, color: [255, 165, 0], width: 3, style: 'dash' as const } as any,
    })

    sketchVM.on('create', (event: any) => {
      if (event.state === 'active' && event.toolEventInfo?.type === 'vertex-add') {
        // Barriera sempre a due punti: chiude automaticamente il disegno appena posizionato il secondo vertice.
        const vertexCount = event.graphic?.geometry?.paths?.[0]?.length ?? 0
        if (vertexCount >= 2) {
          sketchVM?.complete()
        }
      } else if (event.state === 'complete') {
        isDrawing.value = false
        // Id/etichetta assegnati sul graphic stesso: sopravvivono a spostamenti/reshape e restano leggibili da rebuildCrossings.
        if (event.graphic) {
          const n = nextBarrierNumber++
          event.graphic.attributes = { barrierId: `barrier-${n}`, barrierLabel: `Barriera ${n}` }
        }
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
    } catch (err: any) {
      // goTo si interrompe normalmente se una nuova navigazione lo sostituisce (es. l'utente muove la mappa): non è un errore.
      if (err?.name !== 'AbortError') {
        console.warn('goTo error:', err)
      }
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

// Ricostruisce da zero `crossings` da TUTTE le geometrie in sketchLayer, cosi' spostare/eliminare una barriera si riflette correttamente sull'analisi.
function rebuildCrossings(): void {
  crossings = []
  crossingsCount.value = 0
  cutMarkersLayer?.removeAll()

  if (!sketchLayer || !roadGraph || !allFeatures.length) return

  const barrierGraphics = sketchLayer.graphics.toArray()

  barrierGraphics.forEach((graphic: any) => {
    const barrierId = graphic.attributes?.barrierId ?? 'barrier-unknown'
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

      // Taglio vicino a un nodo puo' produrre un pezzo degenere senza vertici: scartalo invece di crashare.
      const startPath = (partStart as any)?.paths?.[0]
      const endPath = (partEnd as any)?.paths?.[0]
      if (!startPath?.length || !endPath?.length) {
        console.warn(`OID ${oid}: taglio degenere, pezzo senza vertici`)
        return
      }

      const cutNodeA = `CUT_A_${oid}`
      const cutNodeB = `CUT_B_${oid}`

      crossings.push({ oid, start, end, cutNodeA, cutNodeB, partStart, partEnd, barrierId })
      crossingsCount.value = crossings.length

      // Marker sul punto di taglio
      const cutPt = startPath[startPath.length - 1]
      cutMarkersLayer?.add(
        new Graphic({
          geometry: { type: 'point', x: cutPt[0], y: cutPt[1], spatialReference: { wkid: 4326 } } as any,
          symbol: {
            type: 'simple-marker',
            color: [230, 126, 34],
            size: 14,
            style: 'x',
            outline: { color: [255, 255, 255], width: 1.5 },
          } as any,
        })
      )
    })
  })
}

// Punto d'ingresso comune per creazione/spostamento/eliminazione barriera: ricalcola l'analisi e aggiorna la UI.
function recomputeAndApply(actionMessage: string) {
  log(actionMessage)
  rebuildCrossings()

  if (!sketchLayer || sketchLayer.graphics.length === 0) {
    applyCleanState()
    return
  }

  const result = updateHighlight()
  if (result) barriers.value = buildBarrierSummaries(result)
}

// Dati per-barriera nell'ordine di sketchLayer (ordine di creazione, non riassegnato alle eliminazioni).
function buildBarrierSummaries(result: DisconnectionResult): BarrierSummary[] {
  if (!sketchLayer) return []

  const cutCountByBarrier = new Map<string, number>()
  crossings.forEach((c) => {
    cutCountByBarrier.set(c.barrierId, (cutCountByBarrier.get(c.barrierId) ?? 0) + 1)
  })

  const isolatedCountByBarrier = new Map<string, number>()
  result.disconnectedOidBarrier.forEach((barrierId) => {
    isolatedCountByBarrier.set(barrierId, (isolatedCountByBarrier.get(barrierId) ?? 0) + 1)
  })

  return sketchLayer.graphics.toArray().map((graphic: any) => {
    const id = graphic.attributes?.barrierId ?? 'barrier-unknown'
    const label = graphic.attributes?.barrierLabel ?? 'Barriera'
    return {
      id,
      label,
      cutCount: cutCountByBarrier.get(id) ?? 0,
      isolatedCount: isolatedCountByBarrier.get(id) ?? 0,
    }
  })
}

function zoomToBarrier(barrierId: string) {
  if (!sketchLayer || !props.view) return

  const graphic: any = sketchLayer.graphics.toArray().find((g: any) => g.attributes?.barrierId === barrierId)
  const extent = graphic?.geometry?.extent
  if (!extent) return

  // Esce prima da un'eventuale sessione di editing attiva, per non lasciare l'overlay disallineato rispetto alla nuova posizione della camera.
  cancelActiveSketchSession()

  // Scala esplicita invece di goTo su extent: piu' prevedibile per target piccoli (segmenti brevi), specie in 3D dove goTo puo' fare uno zoom-out eccessivo.
  const MIN_SPAN_METERS = 300
  const span = Math.max(extent.width, extent.height, MIN_SPAN_METERS) * 4
  // Fattore empirico: uno "span" di N metri occupa circa l'intera larghezza mappa a questa scala.
  const scale = span * 12

  props.view.goTo({ target: extent.center, scale }).catch((err: any) => {
    if (err?.name !== 'AbortError') console.warn('goTo barriera error:', err)
  })
}

// Elimina una barriera dalla lista (senza l'icona nativa Esri): esce da editing attivo, poi ricalcola come dopo un'eliminazione via mappa.
function deleteBarrier(barrierId: string) {
  if (!sketchLayer) return

  const graphic = sketchLayer.graphics.toArray().find((g: any) => g.attributes?.barrierId === barrierId)
  if (!graphic) return

  cancelActiveSketchSession()
  sketchLayer.remove(graphic)
  suppressGraphicClickBriefly()
  recomputeAndApply('Barriera eliminata: ricalcolo...')
}

function updateHighlight(): DisconnectionResult | undefined {
  if (!roadsLayer || !roadGraph) return undefined

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

  return result
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

// Stato pulito equivalente a dopo un Ripristina, riusato anche quando l'eliminazione dell'ultima barriera svuota sketchLayer.
function applyCleanState() {
  cutGraphicsLayer?.removeAll()
  cutMarkersLayer?.removeAll()
  crossings = []
  crossingsCount.value = 0
  blockedCount.value = 0
  disconnectedCount.value = 0
  barriers.value = []
  statusText.value = `Grafo pronto: ${roadGraph?.size ?? 0} nodi, ${allFeatures.length} strade`

  if (roadsLayer) {
    roadsLayer.renderer = {
      type: 'simple' as const,
      symbol: { type: 'simple-line' as const, color: [128, 128, 128], width: 1.5 } as any,
    }
  }
}

function performReset() {
  cancelActiveSketchSession()
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
        <div v-if="blockedCount > 0 || disconnectedCount > 0" class="d-flex gap-2 flex-wrap">
          <span v-if="blockedCount > 0" class="badge badge-outline-primary">
            <i class="mdi mdi-close-octagon-outline me-1" />{{ blockedCount }} tagliata/e
          </span>
          <span v-if="disconnectedCount > 0" class="badge badge-outline-danger">
            <i class="mdi mdi-map-marker-off-outline me-1" />{{ disconnectedCount }} isolate
          </span>
        </div>
      </div>

      <div class="widget-controls d-flex gap-2">
        <button
          class="btn btn-sm btn-primary flex-fill text-nowrap"
          type="button"
          :disabled="!isSketchReady || isEditingBarrier"
          @click="startDrawing"
        >
          <i class="mdi me-2" :class="isDrawing ? 'mdi-close' : 'mdi-pencil'" />
          {{ isDrawing ? 'Annulla disegno' : 'Aggiungi barriera' }}
        </button>
        <button
          class="btn btn-sm flex-fill text-nowrap"
          :class="isResetConfirming ? 'btn-warning' : 'btn-outline-secondary'"
          type="button"
          :disabled="crossingsCount === 0"
          @click="resetAnalysis"
        >
          <i class="mdi me-2" :class="isResetConfirming ? 'mdi-alert-outline' : 'mdi-refresh'" />
          {{ isResetConfirming ? 'Conferma ripristino?' : 'Ripristina' }}
        </button>
      </div>

      <div v-if="!isSketchReady" class="alert alert-info py-2 px-3 mb-0 d-flex align-items-center gap-2">
        <span class="mini-spinner" />
        Preparazione strumenti di disegno...
      </div>
      <div v-else-if="isEditingBarrier" class="alert alert-info py-2 px-3 mb-0 d-flex align-items-center gap-2">
        <span class="mini-spinner" />
        Modifica barriera in corso...
      </div>

      <!-- Lista barriere -->
      <div v-if="barriers.length > 0" class="card barrier-list">
        <div class="card-header">
          <i class="mdi mdi-format-list-bulleted me-2" />
          Lista barriere
        </div>
        <ul class="list-group list-group-flush">
          <li v-for="b in barriers" :key="b.id" class="list-group-item d-flex align-items-center gap-2">
            <span class="text-truncate flex-grow-1">{{ b.label }}</span>
            <span class="barrier-row-metric text-primary">
              <i class="mdi mdi-close-octagon-outline" />{{ b.cutCount }}
            </span>
            <span class="barrier-row-metric text-danger">
              <i class="mdi mdi-map-marker-off-outline" />{{ b.isolatedCount }}
            </span>
            <button
              type="button"
              class="btn btn-outline-secondary barrier-action-btn"
              :aria-label="'Zoom su ' + b.label"
              @click="zoomToBarrier(b.id)"
            >
              <i class="mdi mdi-magnify-plus-outline" />
            </button>
            <button
              type="button"
              class="btn btn-outline-danger barrier-action-btn"
              :aria-label="'Elimina ' + b.label"
              @click="deleteBarrier(b.id)"
            >
              <i class="mdi mdi-trash-can-outline" />
            </button>
          </li>
          <li class="list-group-item list-group-item-primary fw-bold d-flex align-items-center gap-2">
            <span class="flex-grow-1">Totale</span>
            <span class="barrier-row-metric text-primary">
              <i class="mdi mdi-close-octagon-outline" />{{ blockedCount }}
            </span>
            <span class="barrier-row-metric text-danger">
              <i class="mdi mdi-map-marker-off-outline" />{{ disconnectedCount }}
            </span>
            <span class="barrier-zoom-btn-spacer" />
            <span class="barrier-zoom-btn-spacer" />
          </li>
        </ul>
      </div>
      <p v-else class="alert alert-info py-2 px-3 mb-0 d-flex align-items-center gap-2">
        <i class="mdi mdi-information-outline me-1" />
        Nessuna barriera disegnata
      </p>

      <!-- Log Messages -->
      <div v-if="logMessages.length > 0" class="card widget-log">
        <div class="card-header">
          <i class="mdi mdi-text-box-outline me-2" />
          Registro operazioni
        </div>
        <ul class="list-group list-group-flush log-entries">
          <li v-for="(msg, idx) in logMessages" :key="idx" class="list-group-item log-entry">
            {{ msg }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style src="./Barrier.css" scoped></style>
