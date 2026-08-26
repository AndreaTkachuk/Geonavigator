export interface RoadFeature {
  attributes: { OBJECTID: number; [key: string]: any }
  geometry: { paths: number[][][] }
}

export interface RoadGraph {
  nodeMap: Map<string, Array<{ neighbor: string; oid: number }>>
  features: RoadFeature[]
}

function nodeKey(x: number, y: number): string {
  return x.toFixed(6) + ',' + y.toFixed(6)
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
  'https://portalgis.wheretech.it/server/rest/services/INVA/INVA_Network/MapServer/8/query'
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
  const graph = new Map<string, Array<{ neighbor: string; oid: number }>>()

  features.forEach((f) => {
    const oid = f.attributes.OBJECTID
    if (!oid) return

    const paths = f.geometry.paths[0]
    if (!paths || paths.length < 2) return

    const start = paths[0]
    const end = paths[paths.length - 1]
    addEdge(graph, nodeKey(start[0], start[1]), nodeKey(end[0], end[1]), oid)
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
      'Error loading road data. Se l\'errore riportato dal browser menziona CORS/Cross-Origin, '
      + 'occorre abilitare CORS per questa origine sul portale GIS (configurazione lato server, '
      + 'non risolvibile dal codice del progetto):',
      error
    )
    throw error
  }
}

export function getNodeKey(x: number, y: number): string {
  return nodeKey(x, y)
}
