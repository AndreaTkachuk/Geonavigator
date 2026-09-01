export interface RoadFeature {
  attributes: { OBJECTID: number; [key: string]: any }
  geometry: { paths: number[][][] }
}

export interface RoadGraph {
  nodeMap: Map<string, Array<{ neighbor: string; oid: number }>>
  features: RoadFeature[]
}

export interface JunctionFeature {
  attributes: { OBJECTID: number; [key: string]: any }
  geometry: { x: number; y: number }
}

// Tolleranza di snap dei nodi: estremi di segmenti entro questa distanza condividono la stessa chiave di nodo.
const NODE_SNAP_TOLERANCE_METERS = 1.5
// Latitudine di riferimento (Valle d'Aosta) per la conversione gradi→metri con proiezione equirettangolare locale.
const REFERENCE_LATITUDE_DEG = 45.7
const METERS_PER_DEGREE_LAT = 111320
const METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * Math.cos((REFERENCE_LATITUDE_DEG * Math.PI) / 180)
const SNAP_CELL_SIZE_LAT_DEG = NODE_SNAP_TOLERANCE_METERS / METERS_PER_DEGREE_LAT
const SNAP_CELL_SIZE_LON_DEG = NODE_SNAP_TOLERANCE_METERS / METERS_PER_DEGREE_LON

interface SnapGridPoint { x: number; y: number; key: string }

// Griglia hash (bucket per cella di tolleranza) e cache raw->chiave, per evitare confronti O(n^2) tra migliaia di nodi.
const snapGrid = new Map<string, SnapGridPoint[]>()
const rawToSnappedKey = new Map<string, string>()

function rawCoordKey(x: number, y: number): string {
  return x.toFixed(6) + ',' + y.toFixed(6)
}

function distanceMeters(x1: number, y1: number, x2: number, y2: number): number {
  const dx = (x2 - x1) * METERS_PER_DEGREE_LON
  const dy = (y2 - y1) * METERS_PER_DEGREE_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

function snapCellOf(x: number, y: number): [number, number] {
  return [Math.floor(x / SNAP_CELL_SIZE_LON_DEG), Math.floor(y / SNAP_CELL_SIZE_LAT_DEG)]
}

function snapCellKey(cx: number, cy: number): string {
  return cx + '_' + cy
}

function resetNodeSnapIndex(): void {
  snapGrid.clear()
  rawToSnappedKey.clear()
}

// Cerca tra i punti gia' registrati nelle celle vicine il piu' vicino entro tolleranza, altrimenti registra x,y come nuovo nodo.
function snapNodeKey(x: number, y: number): string {
  const rawKey = rawCoordKey(x, y)
  const cached = rawToSnappedKey.get(rawKey)
  if (cached) return cached

  const [cx, cy] = snapCellOf(x, y)
  let closest: SnapGridPoint | null = null
  let closestDist = Infinity

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = snapGrid.get(snapCellKey(cx + dx, cy + dy))
      if (!bucket) continue
      for (const p of bucket) {
        const d = distanceMeters(x, y, p.x, p.y)
        if (d <= NODE_SNAP_TOLERANCE_METERS && d < closestDist) {
          closest = p
          closestDist = d
        }
      }
    }
  }

  const snappedKey = closest ? closest.key : rawKey
  rawToSnappedKey.set(rawKey, snappedKey)

  const cell = snapCellKey(cx, cy)
  const point: SnapGridPoint = { x, y, key: snappedKey }
  const bucket = snapGrid.get(cell)
  if (bucket) bucket.push(point)
  else snapGrid.set(cell, [point])

  return snappedKey
}

function addEdge(
  g: Map<string, Array<{ neighbor: string; oid: number }>>,
  a: string,
  b: string,
  oid: number
): void {
  if (!g.has(a)) g.set(a, [])
  if (!g.has(b)) g.set(b, [])
  g.get(a)!.push({ neighbor: b, oid })
  g.get(b)!.push({ neighbor: a, oid })
}

const ROAD_SERVICE_QUERY_URL =
  'https://portalgis.wheretech.it/server/rest/services/INVA/inva_network_analysis/MapServer/8/query'
const JUNCTIONS_SERVICE_QUERY_URL =
  'https://portalgis.wheretech.it/server/rest/services/INVA/inva_network_analysis/MapServer/7/query'
// SR nativo del network dataset (confermato via metadati REST del NAServer): usarlo come outSR
// evita di dover riproiettare le junction lato client prima di passarle come facilities.
export const NETWORK_SR_WKID = 23032
const PAGE_SIZE = 2000

function isValidRoadFeature(f: any): f is RoadFeature {
  return !!f
    && typeof f.attributes?.OBJECTID === 'number'
    && Array.isArray(f.geometry?.paths)
    && Array.isArray(f.geometry.paths[0])
}

async function fetchRoadPage(resultOffset: number): Promise<{ features: RoadFeature[]; exceededTransferLimit: boolean }> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultOffset: String(resultOffset),
    resultRecordCount: String(PAGE_SIZE),
  })

  let response: Response
  try {
    response = await fetch(`${ROAD_SERVICE_QUERY_URL}?${params.toString()}`)
  } catch (err) {
    throw new Error(
      'Impossibile raggiungere il servizio stradale del portale GIS (portalgis.wheretech.it). '
      + 'Verifica la connessione o riprova più tardi.'
    )
  }

  if (!response.ok) {
    throw new Error(
      `Impossibile raggiungere il servizio stradale del portale GIS (portalgis.wheretech.it). `
      + `Il servizio ha risposto con stato ${response.status}.`
    )
  }

  const payload = await response.json()

  if (payload.error) {
    throw new Error(
      `Il servizio stradale del portale GIS (portalgis.wheretech.it) ha restituito un errore: `
      + `${payload.error.message ?? 'errore sconosciuto'}`
    )
  }

  const features: RoadFeature[] = (payload.features ?? []).filter(isValidRoadFeature)

  return { features, exceededTransferLimit: payload.exceededTransferLimit === true }
}

async function fetchAllRoadFeatures(): Promise<RoadFeature[]> {
  const allFeatures: RoadFeature[] = []
  let offset = 0

  while (true) {
    const { features, exceededTransferLimit } = await fetchRoadPage(offset)
    allFeatures.push(...features)

    if (!exceededTransferLimit) break
    offset += PAGE_SIZE
  }

  return allFeatures
}

function buildGraphFromFeatures(features: RoadFeature[]): Map<string, Array<{ neighbor: string; oid: number }>> {
  resetNodeSnapIndex()
  const graph = new Map<string, Array<{ neighbor: string; oid: number }>>()

  features.forEach((f) => {
    const oid = f.attributes.OBJECTID
    if (!oid) return

    const paths = f.geometry.paths[0]
    if (!paths || paths.length < 2) return

    const start = paths[0]
    const end = paths[paths.length - 1]
    addEdge(graph, snapNodeKey(start[0], start[1]), snapNodeKey(end[0], end[1]), oid)
  })

  return graph
}

export async function loadRoadData(): Promise<RoadGraph> {
  try {
    const features = await fetchAllRoadFeatures()

    if (features.length === 0) {
      throw new Error(
        'Il servizio stradale del portale GIS (portalgis.wheretech.it) non ha restituito alcuna strada.'
      )
    }

    const nodeMap = buildGraphFromFeatures(features)

    return { nodeMap, features }
  } catch (error) {
    console.error(
      'Errore nel caricamento dei dati stradali. Se l\'errore riportato dal browser menziona CORS/Cross-Origin, '
      + 'occorre abilitare CORS per questa origine sul portale GIS (configurazione lato server, '
      + 'non risolvibile dal codice del progetto):',
      error
    )
    throw error
  }
}

export function getNodeKey(x: number, y: number): string {
  return snapNodeKey(x, y)
}

// Interroga le junction del network dataset per OBJECTID, pre-riproiettate a NETWORK_SR_WKID
// dal servizio stesso (outSR): servono come facilities per il calcolo delle isole disconnesse.
export async function queryJunctionsByOids(oids: number[]): Promise<JunctionFeature[]> {
  if (oids.length === 0) return []

  const params = new URLSearchParams({
    where: `OBJECTID IN (${oids.join(',')})`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: String(NETWORK_SR_WKID),
    f: 'json',
  })

  let response: Response
  try {
    response = await fetch(`${JUNCTIONS_SERVICE_QUERY_URL}?${params.toString()}`)
  } catch (err) {
    throw new Error(
      'Impossibile raggiungere il servizio junction del portale GIS (portalgis.wheretech.it). '
      + 'Verifica la connessione o riprova più tardi.'
    )
  }

  if (!response.ok) {
    throw new Error(
      `Impossibile raggiungere il servizio junction del portale GIS (portalgis.wheretech.it). `
      + `Il servizio ha risposto con stato ${response.status}.`
    )
  }

  const payload = await response.json()

  if (payload.error) {
    throw new Error(
      `Il servizio junction del portale GIS (portalgis.wheretech.it) ha restituito un errore: `
      + `${payload.error.message ?? 'errore sconosciuto'}`
    )
  }

  return (payload.features ?? []).filter(
    (f: any): f is JunctionFeature =>
      typeof f?.attributes?.OBJECTID === 'number' && typeof f?.geometry?.x === 'number' && typeof f?.geometry?.y === 'number'
  )
}
