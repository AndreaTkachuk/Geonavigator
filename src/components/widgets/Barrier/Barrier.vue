<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import Graphic from '@arcgis/core/Graphic'
import Polyline from '@arcgis/core/geometry/Polyline'
import Polygon from '@arcgis/core/geometry/Polygon'
import Point from '@arcgis/core/geometry/Point'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as projectionUtils from '@arcgis/core/geometry/projectionUtils'
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils'
import { loadRoadData, queryJunctionsByOids, NETWORK_SR_WKID } from '../../utils/roadDataLoader'
import { solveIsolatedIslands, type IslandGroup } from '../../utils/serviceAreaAnalyzer'
import { useBarrierAnalysisStore, type BarrierSummary } from '../../../stores/barrierAnalysis.store'

const props = defineProps<{
  view: any
}>()

const emit = defineEmits<{
  ready: []
}>()

// Stato condiviso (lista barriere, log, conteggi) nello store: il pannello separato BarrierResults lo legge.
const barrierStore = useBarrierAnalysisStore()

// Stato
const isLoading = ref(true)
const loadError = ref<string | null>(null)
const statusText = ref('Caricamento dati strade...')
const isSketchReady = ref(false)
const isDrawing = ref(false)
const isEditingBarrier = ref(false)
// Numero di barriere attualmente disegnate: guida l'abilitazione del pulsante Ripristina.
const barrierCount = ref(0)
const isResetConfirming = ref(false)
let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null

// Dati
let roadGraph: Map<string, Array<{ neighbor: string; oid: number }>> | null = null
let allFeatures: any[] = []
// OBJECTID -> feature strada, per lookup O(1) nel calcolo della popolazione isolata.
let roadFeatureByOid = new Map<number, any>()
// Contatore progressivo per id/etichetta delle barriere: non si riassegna mai, cosi' eliminarne una in mezzo alla lista non rinumera le altre.
let nextBarrierNumber = 1

// Layer
let roadsLayer: GeoJSONLayer | null = null
let sketchLayer: GraphicsLayer | null = null
let cutRoadsLayer: GraphicsLayer | null = null   // strade tagliate dalle barriere (blu tratteggiato), calcolo locale
let facilityLayer: GraphicsLayer | null = null   // junction usate come facilities nel calcolo (marker neri)
let islandsLayer: GraphicsLayer | null = null    // isole disconnesse restituite dal servizio (verde = rete principale, rosso = isole)
let isolatedHexagonsLayer: GraphicsLayer | null = null // esagoni di popolazione toccati da un'isola disconnessa (arancione)
let sketchVM: SketchViewModel | null = null
const SELECT_CLICK_COOLDOWN_MS = 600

// Esagoni con popolazione, usati per interrogare (e disegnare) la popolazione isolata per ciascuna isola
// disconnessa: il FeatureLayer stesso non viene mai aggiunto alla mappa, solo interrogato.
const HEXAGONS_LAYER_URL = 'https://portalgis.wheretech.it/server/rest/services/Hosted/inva_demo_esagoni/FeatureServer/0'
const hexagonsLayer = new FeatureLayer({ url: HEXAGONS_LAYER_URL, title: 'Esagoni popolazione' })

function log(msg: string) {
  barrierStore.logMessages.unshift(msg)
  if (barrierStore.logMessages.length > 10) barrierStore.logMessages.pop()
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
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
    roadFeatureByOid = new Map(allFeatures.map((f) => [f.attributes.OBJECTID, f]))

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

function createSketchViewModel(): SketchViewModel {
  const vm = new SketchViewModel({
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

  vm.on('create', (event: any) => {
    if (event.state === 'active' && event.toolEventInfo?.type === 'vertex-add') {
      // Barriera sempre a due punti: chiude automaticamente il disegno appena posizionato il secondo vertice.
      const vertexCount = event.graphic?.geometry?.paths?.[0]?.length ?? 0
      if (vertexCount >= 2) {
        sketchVM?.complete()
      }
    } else if (event.state === 'complete') {
      isDrawing.value = false
      // Id/etichetta assegnati sul graphic stesso: sopravvivono a spostamenti/reshape e restano leggibili da findCutRoadsByBarrier.
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

  vm.on('update', (event) => {
    if (event.state === 'start' || event.state === 'active') {
      isEditingBarrier.value = true
    } else if (event.state === 'complete') {
      isEditingBarrier.value = false
      suppressGraphicClickBriefly()
      recomputeAndApply('Barriera spostata: ricalcolo...')
    }
  })

  vm.on('delete', () => {
    isEditingBarrier.value = false
    suppressGraphicClickBriefly()
    recomputeAndApply('Barriera eliminata: ricalcolo...')
  })

  return vm
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
  isolatedHexagonsLayer = new GraphicsLayer({ title: 'Esagoni isolati' })
  islandsLayer = new GraphicsLayer({ title: 'Isole disconnesse' })
  facilityLayer = new GraphicsLayer({ title: 'Junction (facilities)' })
  cutRoadsLayer = new GraphicsLayer({ title: 'Strade tagliate' })

  // Ordine dei layer = ordine di disegno: gli esagoni (aree) restano sotto le linee delle strade, che a loro
  // volta devono restare sempre visibili sopra le isole colorate.
  props.view.map.addMany([roadsLayer, isolatedHexagonsLayer, islandsLayer, facilityLayer, cutRoadsLayer, sketchLayer])

  // Aspetta che il layer sia caricato
  roadsLayer.load().then(async () => {
    sketchVM = createSketchViewModel()
    isSketchReady.value = true

    // Zoom sull'estensione delle strade
    try {
      if (roadsLayer?.fullExtent) {
        await props.view.goTo(roadsLayer.fullExtent)
      }
    } catch (err: any) {
      // goTo si interrompe normalmente se una nuova navigazione lo sostituisce (es. l'utente muove la mappa): non è un errore.
      if (err?.name !== 'AbortError') {
        console.warn('Errore goTo:', err)
      }
    }
  }).catch((err) => {
    console.error('Errore caricamento layer strade:', err)
    loadError.value = `Errore caricamento strade: ${err.message}`
  })
}

// Al cambio 2D/3D props.view punta a una mappa nuova: riaggancia gli stessi layer (dati/barriere/risultati gia' presenti) invece di ricrearli.
watch(() => props.view, (newView, oldView) => {
  // Al cambio 2D/3D, ViewerPage azzera mapView PRIMA di smontare il vecchio arcgis-map/arcgis-scene:
  // staccare qui i layer condivisi dalla vecchia mappa evita che la distruzione del vecchio elemento
  // (che distrugge anche i layer ancora presenti nella sua mappa) li porti via con se'. Senza questo,
  // riaggiungerli alla nuova view fallisce con "Instance of ... is already destroyed": il layer tecnicamente
  // compare in map.layers ma il suo layerview non si crea mai, quindi resta invisibile.
  const ownedLayers = [roadsLayer, isolatedHexagonsLayer, islandsLayer, facilityLayer, cutRoadsLayer, sketchLayer].filter(
    (l): l is NonNullable<typeof l> => l != null
  )
  if (oldView?.map && ownedLayers.length > 0) {
    oldView.map.removeMany(ownedLayers)
  }

  if (!newView || !roadsLayer || !sketchLayer || !isolatedHexagonsLayer || !islandsLayer || !facilityLayer || !cutRoadsLayer) return

  newView.map.addMany(ownedLayers)

  sketchVM?.destroy()
  sketchVM = createSketchViewModel()
  isSketchReady.value = true
})

// Per ogni barriera in sketchLayer, trova localmente (geometryEngine.intersects contro allFeatures,
// gia' caricato in 4326) gli OID delle strade da essa attraversate.
function findCutRoadsByBarrier(): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>()
  if (!sketchLayer || !allFeatures.length) return result

  sketchLayer.graphics.forEach((graphic: any) => {
    const barrierId = graphic.attributes?.barrierId ?? 'barrier-unknown'
    let barrierGeometry = graphic.geometry

    try {
      if (webMercatorUtils.canProject(barrierGeometry, { wkid: 4326 })) {
        barrierGeometry = webMercatorUtils.webMercatorToGeographic(barrierGeometry)
      }
    } catch (err) {
      console.warn('Riproiezione barriera non riuscita:', err)
    }

    const oids = new Set<number>()
    allFeatures.forEach((f) => {
      if (geometryEngine.intersects(f.geometry as any, barrierGeometry)) {
        oids.add(f.attributes.OBJECTID)
      }
    })
    result.set(barrierId, oids)
  })

  return result
}

// Ridisegna in blu tratteggiato tutte le strade tagliate (unione su tutte le barriere). Restituisce l'insieme totale di OID.
function redrawCutRoads(cutOidsByBarrier: Map<string, Set<number>>): Set<number> {
  cutRoadsLayer?.removeAll()

  const allCutOids = new Set<number>()
  cutOidsByBarrier.forEach((oids) => oids.forEach((oid) => allCutOids.add(oid)))

  allCutOids.forEach((oid) => {
    const feature = allFeatures.find((f) => f.attributes.OBJECTID === oid)
    if (!feature) return
    cutRoadsLayer?.add(
      new Graphic({
        // Geometria come istanza reale di Polyline, non un oggetto JSON generico: in SceneView (3D) i
        // graphics con geometria "plain object" non producono un layerview visibile, mentre in MapView (2D)
        // il rendering e' piu' permissivo e li converte automaticamente.
        geometry: new Polyline({ paths: feature.geometry.paths, spatialReference: { wkid: 4326 } }),
        symbol: { type: 'simple-line' as const, color: [0, 0, 255], width: 2, style: 'dash' as const } as any,
      })
    )
  })

  return allCutOids
}

// Dati per-barriera nell'ordine di sketchLayer. isolatedCount e' un'approssimazione: quante delle strade
// tagliate DA QUESTA barriera fanno parte di un'isola disconnessa nel risultato complessivo (cumulativo su
// tutte le barriere) - il servizio non restituisce un'attribuzione esatta per singola barriera.
function buildBarrierSummaries(cutOidsByBarrier: Map<string, Set<number>>, isolatedOids: Set<number>): BarrierSummary[] {
  if (!sketchLayer) return []

  return sketchLayer.graphics.toArray().map((graphic: any) => {
    const id = graphic.attributes?.barrierId ?? 'barrier-unknown'
    const label = graphic.attributes?.barrierLabel ?? 'Barriera'
    const cutOids = cutOidsByBarrier.get(id) ?? new Set<number>()

    let isolatedCount = 0
    cutOids.forEach((oid) => {
      if (isolatedOids.has(oid)) isolatedCount++
    })

    return { id, label, cutCount: cutOids.size, isolatedCount }
  })
}

// Per ciascuna isola disconnessa (esclusa la rete principale all'indice 0), unisce le geometrie delle sue
// strade e interroga il layer esagoni-popolazione per stimare quanti abitanti restano isolati. Un esagono
// toccato da piu' isole viene conteggiato una sola volta (nella prima isola che lo incontra), per non
// gonfiare il totale complessivo.
async function computeIsolatedPopulation(distinctGroups: IslandGroup[]): Promise<number> {
  let totalIsolatedPopulation = 0
  const popSummaryLines: string[] = []
  const countedHexOids = new Set<number>()
  const isolatedHexPolygons: Polygon[] = []

  for (let idx = 0; idx < distinctGroups.length; idx++) {
    if (idx === 0) continue // rete principale, non e' "isolata"
    const group = distinctGroups[idx]

    const geometries = [...group.oidPaths.keys()]
      .map((oid) => roadFeatureByOid.get(oid))
      .filter((f) => f)
      .map((f) => new Polyline({ paths: f.geometry.paths, spatialReference: { wkid: 4326 } }))

    if (geometries.length === 0) continue

    let unionGeom: any
    try {
      unionGeom = geometries.length === 1 ? geometries[0] : geometryEngine.union(geometries)
    } catch (err) {
      console.error(`Errore unendo le geometrie per l'isola ${idx}:`, err)
      continue
    }

    const hexQuery = hexagonsLayer.createQuery()
    hexQuery.geometry = unionGeom
    hexQuery.spatialRelationship = 'intersects'
    hexQuery.outFields = ['objectid', 'totale_abitanti']
    hexQuery.returnGeometry = true
    hexQuery.outSpatialReference = { wkid: NETWORK_SR_WKID } as any

    let hexResult
    try {
      hexResult = await hexagonsLayer.queryFeatures(hexQuery)
    } catch (err) {
      console.error(`Errore interrogando gli esagoni per l'isola ${idx}:`, err)
      log(`Errore nel calcolo della popolazione isolata per l'isola ${idx} (vedi console).`)
      continue
    }

    let popolazioneIsola = 0
    let esagoniGiaContati = 0

    hexResult.features.forEach((f: any) => {
      const hexOid = f.attributes.objectid
      if (countedHexOids.has(hexOid)) {
        esagoniGiaContati++
        return // gia' conteggiato da un'altra isola, evita il doppio conteggio
      }
      countedHexOids.add(hexOid)
      popolazioneIsola += f.attributes.totale_abitanti || 0
      if (f.geometry?.rings) {
        isolatedHexPolygons.push(new Polygon({ rings: f.geometry.rings, spatialReference: { wkid: NETWORK_SR_WKID } }))
      }
    })

    totalIsolatedPopulation += popolazioneIsola

    let line = `Isola ${idx}: ${popolazioneIsola} abitanti isolati (${hexResult.features.length - esagoniGiaContati} esagoni)`
    if (esagoniGiaContati > 0) {
      line += ` - ${esagoniGiaContati} esagono/i gia' conteggiato/i da un'altra isola, escluso/i dal totale`
    }
    popSummaryLines.push(line)
  }

  if (popSummaryLines.length > 0) {
    popSummaryLines.forEach((line) => log(line))
    log(`Totale complessivo: ${totalIsolatedPopulation} abitanti isolati.`)
  } else {
    log('Nessuna isola disconnessa: nessun abitante isolato.')
  }

  // Disegna gli esagoni isolati (deduplicati sopra): riproiezione in un'unica chiamata batch, come per le
  // altre geometrie del widget, per non bloccare il thread principale con tante chiamate singole.
  isolatedHexagonsLayer?.removeAll()
  if (isolatedHexPolygons.length > 0) {
    await projectionUtils.load()
    const wgs84Hexagons = projectionUtils.project(isolatedHexPolygons, { wkid: 4326 })
    const hexGraphics = wgs84Hexagons.map(
      (geometry) =>
        new Graphic({
          geometry,
          symbol: {
            type: 'simple-fill' as const,
            color: [255, 165, 0, 0.35],
            outline: { color: [255, 140, 0], width: 1.5 },
          } as any,
        })
    )
    isolatedHexagonsLayer?.addMany(hexGraphics)
  }

  return totalIsolatedPopulation
}

// Punto d'ingresso comune per creazione/spostamento/eliminazione barriera: ricalcola l'analisi e aggiorna la UI.
async function recomputeAndApply(actionMessage: string) {
  log(actionMessage)

  if (!sketchLayer || sketchLayer.graphics.length === 0) {
    applyCleanState()
    return
  }

  barrierCount.value = sketchLayer.graphics.length

  const cutOidsByBarrier = findCutRoadsByBarrier()
  const allCutOids = redrawCutRoads(cutOidsByBarrier)
  barrierStore.blockedCount = allCutOids.size

  if (allCutOids.size === 0) {
    barrierStore.disconnectedCount = 0
    barrierStore.isolatedPopulation = 0
    islandsLayer?.removeAll()
    facilityLayer?.removeAll()
    isolatedHexagonsLayer?.removeAll()
    barrierStore.barriers = buildBarrierSummaries(cutOidsByBarrier, new Set())
    statusText.value = 'Nessuna strada tagliata dalle barriere'
    return
  }

  // Le junction ai due estremi di ogni strada tagliata sono i punti da cui verificare la connettivita' residua.
  const junctionOids = new Set<number>()
  allCutOids.forEach((oid) => {
    const feature = allFeatures.find((f) => f.attributes.OBJECTID === oid)
    const j1 = feature?.attributes?.Junction1_OID
    const j2 = feature?.attributes?.Junction2_OID
    if (j1 !== null && j1 !== undefined) junctionOids.add(j1)
    if (j2 !== null && j2 !== undefined) junctionOids.add(j2)
  })

  if (junctionOids.size === 0) {
    log('Nessuna junction associata alle strade tagliate (campi Junction1_OID/2_OID vuoti).')
    barrierStore.disconnectedCount = 0
    barrierStore.isolatedPopulation = 0
    islandsLayer?.removeAll()
    facilityLayer?.removeAll()
    isolatedHexagonsLayer?.removeAll()
    barrierStore.barriers = buildBarrierSummaries(cutOidsByBarrier, new Set())
    return
  }

  statusText.value = `Recupero di ${junctionOids.size} junction...`

  let junctions
  try {
    junctions = await queryJunctionsByOids([...junctionOids])
  } catch (err) {
    console.error('Errore interrogando le junction:', err)
    loadError.value = err instanceof Error ? err.message : 'Errore nella query junctions'
    return
  }

  facilityLayer?.removeAll()
  // SceneView (3D) scarta silenziosamente i graphics la cui spatial reference considera "incompatibile":
  // il wkid nativo del network (23032) rientra in questo caso, quindi si riproietta in WGS84 (4326) prima
  // di disegnare, come gia' fatto per le altre geometrie di questo widget.
  await projectionUtils.load()
  junctions.forEach((j) => {
    const networkPoint = new Point({ x: j.geometry.x, y: j.geometry.y, spatialReference: { wkid: NETWORK_SR_WKID } })
    const wgs84Point = projectionUtils.project(networkPoint, { wkid: 4326 })
    facilityLayer?.add(
      new Graphic({
        geometry: wgs84Point,
        symbol: {
          type: 'simple-marker',
          color: [0, 0, 0],
          size: 8,
          outline: { color: [255, 255, 255], width: 1 },
        } as any,
      })
    )
  })

  log(`${junctions.length} junction recuperata/e, usate come facilities.`)

  const barrierGeometries = sketchLayer.graphics.toArray().map((g: any) => g.geometry)
  const barrierSRWkid = barrierGeometries[0]?.spatialReference?.wkid ?? 102100

  let solveResult
  try {
    solveResult = await solveIsolatedIslands(junctions, barrierGeometries, barrierSRWkid, (i, total) => {
      statusText.value = `Chiamata al servizio: facility ${i + 1}/${total}...`
    })
  } catch (err) {
    console.error('Errore nella chiamata al servizio Network Analyst:', err)
    loadError.value = 'Errore nella chiamata al servizio Network Analyst'
    return
  }

  const { distinctGroups, spatialReference } = solveResult

  if (distinctGroups.length === 0) {
    log('Nessuna polilinea restituita da nessuna facility.')
    islandsLayer?.removeAll()
    isolatedHexagonsLayer?.removeAll()
    barrierStore.disconnectedCount = 0
    barrierStore.isolatedPopulation = 0
    barrierStore.barriers = buildBarrierSummaries(cutOidsByBarrier, new Set())
    statusText.value = `${barrierStore.blockedCount} ${pluralize(barrierStore.blockedCount, 'strada tagliata', 'strade tagliate')}: 0 strade isolate`
    return
  }

  islandsLayer?.removeAll()
  const isolatedOids = new Set<number>()

  // Il servizio restituisce le geometrie nella spatial reference nativa del network (es. 23032): SceneView
  // (3D) scarta silenziosamente i graphics con quella SR ("incompatible spatial reference"), quindi si
  // riproietta in WGS84 (4326) prima di disegnare, come gia' fatto per le altre geometrie del widget.
  // Riproiezione in un'unica chiamata batch: farla una polyline alla volta (anche migliaia) blocca a lungo
  // il thread principale.
  await projectionUtils.load()

  const networkPolylines: Polyline[] = []

  // La piu' grande e' la rete principale (non evidenziata), tutte le altre sono isole disconnesse (rosso).
  distinctGroups.forEach((group, idx) => {
    const isMain = idx === 0
    if (isMain) return

    group.oidPaths.forEach((paths, oid) => {
      isolatedOids.add(oid)
      networkPolylines.push(new Polyline({ paths, spatialReference }))
    })
  })

  const wgs84Polylines = networkPolylines.length > 0 ? projectionUtils.project(networkPolylines, { wkid: 4326 }) : []

  const graphics = wgs84Polylines.map(
    (geometry) =>
      new Graphic({
        geometry,
        symbol: { type: 'simple-line' as const, color: [255, 0, 0], width: 2 } as any,
      })
  )

  islandsLayer?.addMany(graphics)

  barrierStore.disconnectedCount = isolatedOids.size
  const cutPhrase = pluralize(barrierStore.blockedCount, 'strada tagliata', 'strade tagliate')
  const disconnectedPhrase = pluralize(barrierStore.disconnectedCount, 'strada isolata', 'strade isolate')
  statusText.value = `${barrierStore.blockedCount} ${cutPhrase}: ${barrierStore.disconnectedCount} ${disconnectedPhrase}`
  log(`Analisi completata: ${distinctGroups.length} isola/e distinta/e, ${barrierStore.disconnectedCount} strade isolate`)

  barrierStore.barriers = buildBarrierSummaries(cutOidsByBarrier, isolatedOids)

  barrierStore.isolatedPopulation = await computeIsolatedPopulation(distinctGroups)
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
    if (err?.name !== 'AbortError') console.warn('Errore goTo barriera:', err)
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
  cutRoadsLayer?.removeAll()
  facilityLayer?.removeAll()
  islandsLayer?.removeAll()
  isolatedHexagonsLayer?.removeAll()
  barrierCount.value = 0
  barrierStore.blockedCount = 0
  barrierStore.disconnectedCount = 0
  barrierStore.isolatedPopulation = 0
  barrierStore.barriers = []
  statusText.value = `Grafo pronto: ${roadGraph?.size ?? 0} nodi, ${allFeatures.length} strade`
}

function performReset() {
  cancelActiveSketchSession()
  sketchLayer?.removeAll()
  applyCleanState()
  barrierStore.logMessages = []
}

function resetAnalysis() {
  if (barrierCount.value === 0) return

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
  barrierStore.registerActions({ zoomToBarrier, deleteBarrier })
  void projectionUtils.load()

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
        <div v-if="barrierStore.blockedCount > 0 || barrierStore.disconnectedCount > 0" class="d-flex gap-2 flex-wrap">
          <span v-if="barrierStore.blockedCount > 0" class="badge badge-outline-primary">
            <i class="mdi mdi-close-octagon-outline me-1" />{{ barrierStore.blockedCount }} {{ pluralize(barrierStore.blockedCount, 'tagliata', 'tagliate') }}
          </span>
          <span v-if="barrierStore.disconnectedCount > 0" class="badge badge-outline-danger">
            <i class="mdi mdi-map-marker-off-outline me-1" />{{ barrierStore.disconnectedCount }} {{ pluralize(barrierStore.disconnectedCount, 'isolata', 'isolate') }}
          </span>
          <span v-if="barrierStore.isolatedPopulation > 0" class="badge badge-outline-warning">
            <i class="mdi mdi-account-group-outline me-1" />{{ barrierStore.isolatedPopulation }} {{ pluralize(barrierStore.isolatedPopulation, 'abitante isolato', 'abitanti isolati') }}
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
          :disabled="barrierCount === 0"
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
    </div>
  </div>
</template>

<style src="./Barrier.css" scoped></style>
