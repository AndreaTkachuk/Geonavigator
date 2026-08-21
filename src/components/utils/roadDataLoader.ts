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

function convertGeoJSONToArcGIS(geojsonFeature: any): RoadFeature | null {
  try {
    // Get properties and convert to attributes
    const attributes = {
      OBJECTID: geojsonFeature.properties?.OBJECTID || geojsonFeature.id || 0,
      ...geojsonFeature.properties,
    }

    if (!attributes.OBJECTID) {
      console.warn('Feature missing OBJECTID:', geojsonFeature)
      return null
    }

    // Convert GeoJSON geometry to ArcGIS format
    const geom = geojsonFeature.geometry
    if (!geom || !geom.coordinates) {
      console.warn('Feature missing geometry:', geojsonFeature)
      return null
    }

    let paths: number[][][] = []

    if (geom.type === 'LineString') {
      // LineString: coordinates is [lon, lat][]
      paths = [geom.coordinates as number[][]]
    } else if (geom.type === 'MultiLineString') {
      // MultiLineString: coordinates is [lon, lat][][]
      paths = geom.coordinates as number[][][]
    } else if (geom.type === 'Polygon') {
      // Polygon: coordinates is [lon, lat][][]
      paths = geom.coordinates as number[][][]
    } else {
      console.warn('Unsupported geometry type:', geom.type)
      return null
    }

    return {
      attributes,
      geometry: { paths },
    }
  } catch (error) {
    console.warn('Error converting feature:', error, geojsonFeature)
    return null
  }
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

export async function loadRoadData(jsonPath: string): Promise<RoadGraph> {
  try {
    const response = await fetch(jsonPath)
    if (!response.ok) throw new Error(`Failed to fetch roads: ${response.status}`)

    const geojson = await response.json()
    const rawFeatures = geojson.features || []

    if (rawFeatures.length === 0) {
      throw new Error('No features found in GeoJSON')
    }

    // Convert GeoJSON features to ArcGIS format
    const features: RoadFeature[] = rawFeatures
      .map((f: any) => convertGeoJSONToArcGIS(f))
      .filter((f: RoadFeature | null): f is RoadFeature => f !== null)

    if (features.length === 0) {
      throw new Error('No valid features could be converted from GeoJSON')
    }

    const nodeMap = buildGraphFromFeatures(features)

    return { nodeMap, features }
  } catch (error) {
    console.error('Error loading road data:', error)
    throw error
  }
}

export function getNodeKey(x: number, y: number): string {
  return nodeKey(x, y)
}
