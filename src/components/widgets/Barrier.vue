<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import Graphic from '@arcgis/core/Graphic'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils'
import { loadRoadData, getNodeKey } from '../utils/roadDataLoader'
import {
  analyzeDisconnection,
  type Crossing,
  type DisconnectionResult,
} from '../utils/roadDisconnectionAnalyzer'

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
// Contatore progressivo per id/etichetta delle barriere: non si riassegna
// mai, cosi' eliminare una barriera in mezzo alla lista non rinumera le altre.
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

// Il click (o il secondo click di un doppio click) che completa un
// disegno/spostamento puo' cadere esattamente sulla barriera appena
// creata/aggiornata: disabilitare temporaneamente updateOnGraphicClick evita
// che riavvii subito un'altra sessione di update su quello stesso click.
function suppressGraphicClickBriefly() {
  if (!sketchVM) return
  sketchVM.updateOnGraphicClick = false
  setTimeout(() => {
    if (sketchVM) sketchVM.updateOnGraphicClick = true
  }, SELECT_CLICK_COOLDOWN_MS)
}

// Esce da un'eventuale sessione di disegno/modifica ancora attiva. Va
// chiamato prima di qualsiasi azione che muta i graphics dall'esterno
// (Ripristina, eliminazione dalla lista, zoom su una barriera): farlo
// mentre SketchViewModel sta ancora mostrando le maniglie di editing puo'
// lasciare overlay non sincronizzati con lo stato/camera successivo.
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

  // elevationInfo 'on-the-ground' clampa la barriera al terreno: niente
  // maniglia verticale per alzarla/abbassarla in 3D, l'altezza si regola
  // sempre in automatico seguendo la superficie.
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
      // Selezionare una barriera esistente con un click la fa entrare in
      // modalita' di modifica nativa Esri (reshape/move + icona di eliminazione),
      // senza bisogno di un hit-test/listener di click custom.
      updateOnGraphicClick: true,
      // reshape permette di spostare i due punti esistenti. reshapeOptions e'
      // documentato come "only supported in 3D, partially in 2D": impostarlo
      // anche in 2D puo' rompere il semplice spostamento dei vertici, quindi
      // si applica solo in vista 3D, dove serve per impedire di aggiungere
      // altri punti trascinando il segmento.
      defaultUpdateOptions: (props.view?.type === '3d'
        ? { tool: 'reshape', reshapeOptions: { edgeOperation: 'none', vertexOperation: 'move' } }
        : { tool: 'reshape' }) as any,
      polylineSymbol: { type: 'simple-line' as const, color: [255, 165, 0], width: 3, style: 'dash' as const } as any,
    })

    sketchVM.on('create', (event: any) => {
      if (event.state === 'active' && event.toolEventInfo?.type === 'vertex-add') {
        // La barriera e' sempre un segmento semplice: appena viene
        // posizionato il secondo punto, chiude automaticamente il disegno
        // senza richiedere un doppio click e senza permettere altri vertici.
        const vertexCount = event.graphic?.geometry?.paths?.[0]?.length ?? 0
        if (vertexCount >= 2) {
          sketchVM?.complete()
        }
      } else if (event.state === 'complete') {
        isDrawing.value = false
        // Id/etichetta assegnati qui, sul graphic stesso: sopravvivono a
        // spostamenti/reshape e restano leggibili da rebuildCrossings.
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
      // goTo si interrompe normalmente se una nuova navigazione lo sostituisce
      // (es. l'utente muove la mappa durante il caricamento): non è un errore.
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

      // Spostando una barriera il taglio puo' cadere molto vicino a un nodo
      // stradale e produrre un pezzo degenere (senza vertici): scartalo
      // invece di crashare leggendo un punto inesistente.
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

  const result = updateHighlight()
  if (result) barriers.value = buildBarrierSummaries(result)
}

// Ricava i dati per-barriera (strade tagliate/isolate) dal risultato
// dell'analisi, nell'ordine in cui le barriere compaiono in sketchLayer
// (che coincide con l'ordine di creazione, non riassegnato alle eliminazioni).
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

  // Uscire prima da un'eventuale sessione di modifica attiva: spostare la
  // camera mentre SketchViewModel sta ancora mostrando le maniglie di editing
  // su un grafico puo' lasciare l'overlay di editing disallineato rispetto
  // alla nuova posizione della camera (visivamente incoerente finche' non si
  // interagisce di nuovo con la mappa).
  cancelActiveSketchSession()

  // goTo su un'extent (fit automatico) puo' comportarsi in modo imprevedibile
  // per un target piccolo come un segmento breve, soprattutto in vista 3D
  // (SceneView), dove puo' risultare in uno zoom-out eccessivo invece che un
  // avvicinamento. Calcoliamo quindi noi una scala esplicita da un'estensione
  // con un margine minimo garantito, che si comporta in modo prevedibile
  // tanto in 2D quanto in 3D.
  const MIN_SPAN_METERS = 300
  const span = Math.max(extent.width, extent.height, MIN_SPAN_METERS) * 4
  // Fattore empirico: una vista di "span" metri di lato occupa circa
  // l'intera larghezza della mappa a questa scala (~ metri per pixel * larghezza tipica).
  const scale = span * 12

  props.view.goTo({ target: extent.center, scale }).catch((err: any) => {
    if (err?.name !== 'AbortError') console.warn('goTo barriera error:', err)
  })
}

// Elimina una singola barriera dalla lista (senza passare dall'icona nativa
// Esri sulla mappa). Esce prima da un'eventuale sessione di modifica attiva
// (anche su un'altra barriera) per evitare di alterare i graphics mentre
// SketchViewModel ha ancora un'operazione in corso, poi ricalcola l'analisi
// esattamente come dopo un'eliminazione via mappa.
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
          {{ isDrawing ? 'Annulla disegno' : 'Aggiungi barriera' }}
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

      <!-- Lista barriere -->
      <div v-if="barriers.length > 0" class="barrier-list">
        <div class="widget-log-title">
          <i class="mdi mdi-format-list-bulleted" />
          Lista barriere
        </div>
        <div class="barrier-rows">
          <div v-for="b in barriers" :key="b.id" class="barrier-row">
            <span class="barrier-row-label">{{ b.label }}</span>
            <span class="barrier-row-metric cut">
              <i class="mdi mdi-close-octagon-outline" />{{ b.cutCount }}
            </span>
            <span class="barrier-row-metric isolated">
              <i class="mdi mdi-map-marker-off-outline" />{{ b.isolatedCount }}
            </span>
            <button
              type="button"
              class="barrier-zoom-btn"
              :aria-label="'Zoom su ' + b.label"
              @click="zoomToBarrier(b.id)"
            >
              <i class="mdi mdi-magnify-plus-outline" />
            </button>
            <button
              type="button"
              class="barrier-zoom-btn barrier-delete-btn"
              :aria-label="'Elimina ' + b.label"
              @click="deleteBarrier(b.id)"
            >
              <i class="mdi mdi-trash-can-outline" />
            </button>
          </div>
          <div class="barrier-row barrier-row-total">
            <span class="barrier-row-label">Totale</span>
            <span class="barrier-row-metric cut">
              <i class="mdi mdi-close-octagon-outline" />{{ blockedCount }}
            </span>
            <span class="barrier-row-metric isolated">
              <i class="mdi mdi-map-marker-off-outline" />{{ disconnectedCount }}
            </span>
            <span class="barrier-zoom-btn-spacer" />
            <span class="barrier-zoom-btn-spacer" />
          </div>
        </div>
      </div>
      <p v-else class="barrier-list-empty">
        <i class="mdi mdi-information-outline" />
        Nessuna barriera disegnata
      </p>

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

.widget-log,
.barrier-list {
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(17, 32, 25, 0.06);
  overflow: hidden;
}

.barrier-rows {
  padding: 4px 10px;
  display: flex;
  flex-direction: column;
}

.barrier-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 6px;
  margin: 0 -6px;
  border-radius: 5px;
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
  transition: background 0.12s ease;
}

.barrier-row:not(.barrier-row-total):hover {
  background: var(--barrier-neutral-soft);
}

.barrier-row:last-child {
  border-bottom: none;
}

.barrier-row-label {
  flex: 1 1 auto;
  color: var(--text-strong);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.barrier-row-metric {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  min-width: 30px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.barrier-row-metric .mdi {
  font-size: 13px;
}

.barrier-row-metric.cut {
  color: var(--barrier-primary-deep);
}

.barrier-row-metric.isolated {
  color: #c62828;
}

.barrier-zoom-btn,
.barrier-zoom-btn-spacer {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
}

.barrier-zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface-strong);
  color: var(--text-strong);
  cursor: pointer;
  font-size: 13px;
  padding: 0;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.barrier-zoom-btn:hover {
  background: var(--barrier-primary);
  border-color: var(--barrier-primary);
  color: #fff;
}

.barrier-delete-btn:hover {
  background: #c62828;
  border-color: #c62828;
  color: #fff;
}

.barrier-row-total {
  margin-top: 2px;
  padding: 7px 8px 7px 10px;
  border-top: 1px solid var(--line);
  border-bottom: none;
  border-left: 3px solid var(--barrier-primary);
  background: var(--barrier-neutral-soft);
  border-radius: 5px;
  font-weight: 700;
}

.barrier-row-total .barrier-row-label {
  font-weight: 700;
}

.barrier-list-empty {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text);
  opacity: 0.75;
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
