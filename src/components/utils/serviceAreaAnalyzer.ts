import { NETWORK_SR_WKID, type JunctionFeature } from './roadDataLoader'

const NA_SERVICE_AREA_URL =
  'https://portalgis.wheretech.it/server/rest/services/INVA/inva_network_analysis/NAServer/Service%20Area'
// ID della source delle junction nel network dataset (da NAServer -> networkSources).
const JUNCTION_SOURCE_ID = 2
// Break enorme: vogliamo l'intera area raggiungibile dalla facility, senza limiti di distanza.
const HUGE_BREAK = 999999

function buildFacilityJSON(junction: JunctionFeature): string {
  return JSON.stringify({
    geometryType: 'esriGeometryPoint',
    spatialReference: { wkid: NETWORK_SR_WKID, latestWkid: NETWORK_SR_WKID },
    fields: [
      { name: 'ObjectID', type: 'esriFieldTypeOID', alias: 'ObjectID' },
      { name: 'Name', type: 'esriFieldTypeString', alias: 'Name', length: 500 },
      { name: 'SourceID', type: 'esriFieldTypeInteger', alias: 'SourceID' },
      { name: 'SourceOID', type: 'esriFieldTypeInteger', alias: 'SourceOID' },
    ],
    features: [{
      // La geometria resta solo di riferimento: la posizione reale sulla rete e' determinata da SourceID/SourceOID.
      geometry: { x: junction.geometry.x, y: junction.geometry.y },
      attributes: {
        ObjectID: 1,
        Name: `Junction ${junction.attributes.OBJECTID}`,
        SourceID: JUNCTION_SOURCE_ID,
        SourceOID: junction.attributes.OBJECTID,
      },
    }],
  })
}

// Barriere = le linee disegnate dall'utente. Ogni barriera diventa una feature distinta nello stesso FeatureSet.
function buildBarriersJSON(barrierGeometries: any[], spatialReferenceWkid: number): string {
  return JSON.stringify({
    geometryType: 'esriGeometryPolyline',
    spatialReference: { wkid: spatialReferenceWkid, latestWkid: spatialReferenceWkid },
    fields: [
      { name: 'ObjectID', type: 'esriFieldTypeOID', alias: 'ObjectID' },
      { name: 'Name', type: 'esriFieldTypeString', alias: 'Name', length: 500 },
      { name: 'BarrierType', type: 'esriFieldTypeInteger', alias: 'BarrierType' },
    ],
    features: barrierGeometries.map((geom, idx) => ({
      geometry: { paths: geom.paths },
      attributes: { ObjectID: idx + 1, Name: null, BarrierType: 0 }, // 0 = Restriction, blocco totale
    })),
  })
}

export interface IslandGroup {
  facilityId: number
  // SourceOID (OID strada) -> tutti i paths uniti da tutte le feature con quel SourceOID.
  oidPaths: Map<number, number[][][]>
}

export interface SolveIsolatedIslandsResult {
  distinctGroups: IslandGroup[]
  spatialReference: { wkid: number }
}

// Il servizio ha un difetto noto: processare piu' facilities insieme in una singola chiamata puo'
// fallire con un errore 500 generico su combinazioni specifiche di junction, mentre ogni facility
// presa da sola funziona sempre. Per aggirarlo si chiama il servizio UNA VOLTA PER OGNI FACILITY
// (stesso set di barriere ogni volta) e si uniscono i risultati, invece di un'unica chiamata con tutte.
export async function solveIsolatedIslands(
  junctions: JunctionFeature[],
  barrierGeometries: any[],
  barrierSpatialReferenceWkid: number,
  onProgress?: (index: number, total: number) => void
): Promise<SolveIsolatedIslandsResult> {
  const barriersJSON = buildBarriersJSON(barrierGeometries, barrierSpatialReferenceWkid)

  const allFeatures: any[] = []
  let combinedSpatialReference: { wkid: number } | null = null

  for (let i = 0; i < junctions.length; i++) {
    onProgress?.(i, junctions.length)

    const params = new URLSearchParams({
      f: 'json',
      facilities: buildFacilityJSON(junctions[i]),
      polylineBarriers: barriersJSON,
      defaultBreaks: String(HUGE_BREAK),
      travelDirection: 'esriNATravelDirectionFromFacility',
      outputLines: 'esriNAOutputLineTrueShape',
      outputPolygons: 'esriNAOutputPolygonNone',
      outSR: String(NETWORK_SR_WKID),
    })

    const response = await fetch(`${NA_SERVICE_AREA_URL}/solveServiceArea`, {
      method: 'POST',
      body: params,
    })
    const result = await response.json()

    if (result.error) {
      console.warn(`Errore dal servizio per la junction ${junctions[i].attributes.OBJECTID}:`, result.error)
      continue
    }

    const polylinesFeatureSet = result.saPolylines
    if (polylinesFeatureSet?.features?.length) {
      combinedSpatialReference = polylinesFeatureSet.spatialReference || combinedSpatialReference
      // FacilityID nella risposta e' sempre 1 (una sola facility per chiamata): lo sostituiamo con
      // l'indice reale, cosi' il raggruppamento sotto distingue correttamente le facility.
      polylinesFeatureSet.features.forEach((f: any) => {
        f.attributes.FacilityID = i + 1
      })
      allFeatures.push(...polylinesFeatureSet.features)
    }
  }

  // Raggruppa per FacilityID -> Map(SourceOID -> paths uniti da tutte le feature con quel SourceOID).
  const groups = new Map<number, Map<number, number[][][]>>()

  allFeatures.forEach((f) => {
    const facilityId = f.attributes.FacilityID
    const sourceOid = f.attributes.SourceOID
    if (!groups.has(facilityId)) groups.set(facilityId, new Map())
    const oidPaths = groups.get(facilityId)!
    if (!oidPaths.has(sourceOid)) oidPaths.set(sourceOid, [])
    oidPaths.get(sourceOid)!.push(...f.geometry.paths)
  })

  // Scarta isole con esattamente lo stesso insieme di SourceOID di una gia' vista (stessa rete raggiunta da facility diverse).
  const seenSignatures = new Set<string>()
  const distinctGroups: IslandGroup[] = []

  for (const [facilityId, oidPaths] of groups) {
    const signature = [...oidPaths.keys()].sort((a, b) => a - b).join(',')
    if (seenSignatures.has(signature)) continue
    seenSignatures.add(signature)
    distinctGroups.push({ facilityId, oidPaths })
  }

  // La piu' grande (per numero di strade) e' la rete principale; tutte le altre sono isole disconnesse.
  distinctGroups.sort((a, b) => b.oidPaths.size - a.oidPaths.size)

  return {
    distinctGroups,
    spatialReference: combinedSpatialReference ?? { wkid: NETWORK_SR_WKID },
  }
}
