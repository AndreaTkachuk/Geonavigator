export interface Crossing {
  oid: number
  start: string
  end: string
  cutNodeA: string
  cutNodeB: string
  partStart: any // Polyline geometry
  partEnd: any
  barrierId: string
}

export interface DisconnectionResult {
  disconnectedOids: number[]
  disconnectedCutSides: Map<number, 'A' | 'B' | 'both'>
  blockedOids: number[]
  // Attribuzione per-barriera degli oid isolati: oid -> barrierId "proprietario" (vedi calcolo sotto).
  disconnectedOidBarrier: Map<number, string>
}

type RoadGraph = Map<string, Array<{ neighbor: string; oid: number }>>

function removeEdge(g: RoadGraph, a: string, b: string, oid: number): void {
  if (g.has(a)) g.set(a, g.get(a)!.filter((e) => !(e.neighbor === b && e.oid === oid)))
  if (g.has(b)) g.set(b, g.get(b)!.filter((e) => !(e.neighbor === a && e.oid === oid)))
}

function addEdge(g: RoadGraph, a: string, b: string, oid: number): void {
  if (!g.has(a)) g.set(a, [])
  if (!g.has(b)) g.set(b, [])
  g.get(a)!.push({ neighbor: b, oid })
  g.get(b)!.push({ neighbor: a, oid })
}

function buildScratchGraph(originalGraph: RoadGraph, crossings: Crossing[]): RoadGraph {
  const scratch = new Map<string, Array<{ neighbor: string; oid: number }>>()

  for (const [node, edges] of originalGraph) {
    scratch.set(node, [...edges])
  }

  crossings.forEach(({ oid, start, end, cutNodeA, cutNodeB }) => {
    removeEdge(scratch, start, end, oid)
    addEdge(scratch, start, cutNodeA, oid)
    addEdge(scratch, cutNodeB, end, oid)
  })

  return scratch
}

function getReachableOnGraph(g: RoadGraph, startNode: string): Set<string> {
  const visited = new Set([startNode])
  const queue = [startNode]

  while (queue.length) {
    const current = queue.shift()!
    for (const { neighbor } of g.get(current) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
  }

  return visited
}

export function getAllComponentsOnGraph(g: RoadGraph): Set<string>[] {
  const visited = new Set<string>()
  const components: Set<string>[] = []

  for (const node of g.keys()) {
    if (visited.has(node)) continue
    const comp = getReachableOnGraph(g, node)
    comp.forEach((n) => visited.add(n))
    components.push(comp)
  }

  return components
}

export function analyzeDisconnection(
  originalGraph: RoadGraph,
  crossings: Crossing[]
): DisconnectionResult {
  const blockedOids = crossings.map((c) => c.oid)

  if (crossings.length === 0) {
    return {
      disconnectedOids: [],
      disconnectedCutSides: new Map(),
      blockedOids: [],
      disconnectedOidBarrier: new Map(),
    }
  }

  const scratch = buildScratchGraph(originalGraph, crossings)

  const originalComponents = getAllComponentsOnGraph(originalGraph)
  const nodeToOrigComp = new Map<string, number>()

  originalComponents.forEach((comp, idx) => {
    comp.forEach((n) => nodeToOrigComp.set(n, idx))
  })

  const newComponents = getAllComponentsOnGraph(scratch)

  const groups = new Map<number, Set<string>[]>()

  newComponents.forEach((comp) => {
    const realNode = [...comp].find((n) => !n.startsWith('CUT_'))
    if (realNode === undefined) return

    const origIdx = nodeToOrigComp.get(realNode)
    if (origIdx === undefined) return

    if (!groups.has(origIdx)) groups.set(origIdx, [])
    groups.get(origIdx)!.push(comp)
  })

  const disconnectedOids = new Set<number>()
  const disconnectedComponents: Set<string>[] = []
  // oid isolati introdotti da ciascuna componente disconnessa (stesso indice di disconnectedComponents), per l'attribuzione per-barriera.
  const disconnectedComponentOids: Set<number>[] = []

  for (const comps of groups.values()) {
    if (comps.length <= 1) continue

    comps.sort((a, b) => b.size - a.size)

    for (let i = 1; i < comps.length; i++) {
      disconnectedComponents.push(comps[i])
      const compOids = new Set<number>()
      for (const node of comps[i]) {
        for (const { neighbor, oid } of scratch.get(node) || []) {
          if (comps[i].has(neighbor)) {
            disconnectedOids.add(oid)
            compOids.add(oid)
          }
        }
      }
      disconnectedComponentOids.push(compOids)
    }
  }

  const disconnectedCutSides = new Map<number, 'A' | 'B' | 'both'>()

  crossings.forEach(({ oid, cutNodeA, cutNodeB }) => {
    const aDisconnected = disconnectedComponents.some((comp) => comp.has(cutNodeA))
    const bDisconnected = disconnectedComponents.some((comp) => comp.has(cutNodeB))

    if (aDisconnected && bDisconnected) disconnectedCutSides.set(oid, 'both')
    else if (aDisconnected) disconnectedCutSides.set(oid, 'A')
    else if (bDisconnected) disconnectedCutSides.set(oid, 'B')
  })

  // Ogni componente disconnessa viene attribuita interamente a una sola barriera (la prima in `crossings` che la delimita), cosi' ogni oid isolato ha un proprietario univoco.
  const disconnectedOidBarrier = new Map<number, string>()

  disconnectedComponents.forEach((comp, i) => {
    const owningCrossing = crossings.find((c) => comp.has(c.cutNodeA) || comp.has(c.cutNodeB))
    if (!owningCrossing) return

    for (const oid of disconnectedComponentOids[i]) {
      disconnectedOidBarrier.set(oid, owningCrossing.barrierId)
    }
  })

  if (import.meta.env?.DEV) {
    const attributedCount = disconnectedOidBarrier.size
    if (attributedCount !== disconnectedOids.size) {
      console.warn(
        `[roadDisconnectionAnalyzer] attribuzione per-barriera incompleta: ${attributedCount}/${disconnectedOids.size} oid isolati attribuiti a una barriera`
      )
    }
  }

  return {
    disconnectedOids: [...disconnectedOids],
    disconnectedCutSides,
    blockedOids,
    disconnectedOidBarrier,
  }
}
