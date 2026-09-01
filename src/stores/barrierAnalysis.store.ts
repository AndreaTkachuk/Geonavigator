import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface BarrierSummary {
  id: string
  label: string
  cutCount: number
  isolatedCount: number
}

// Ponte tra il widget Barrier (proprietario di sketchLayer/view e di tutta la logica ArcGIS) e il
// widget BarrierResults (pannello separato con lista barriere e log): Barrier scrive lo stato e
// registra le proprie funzioni, BarrierResults legge lo stato e invoca le funzioni registrate senza
// conoscere i dettagli della mappa.
export const useBarrierAnalysisStore = defineStore('barrierAnalysis', () => {
  const barriers = ref<BarrierSummary[]>([])
  const logMessages = ref<string[]>([])
  const blockedCount = ref(0)
  const disconnectedCount = ref(0)

  const zoomToBarrierAction = ref<((barrierId: string) => void) | null>(null)
  const deleteBarrierAction = ref<((barrierId: string) => void) | null>(null)

  function registerActions(actions: {
    zoomToBarrier: (barrierId: string) => void
    deleteBarrier: (barrierId: string) => void
  }): void {
    zoomToBarrierAction.value = actions.zoomToBarrier
    deleteBarrierAction.value = actions.deleteBarrier
  }

  function zoomToBarrier(barrierId: string): void {
    zoomToBarrierAction.value?.(barrierId)
  }

  function deleteBarrier(barrierId: string): void {
    deleteBarrierAction.value?.(barrierId)
  }

  return {
    barriers,
    logMessages,
    blockedCount,
    disconnectedCount,
    registerActions,
    zoomToBarrier,
    deleteBarrier,
  }
})
