<script setup lang="ts">
import { useBarrierAnalysisStore } from '../../../stores/barrierAnalysis.store'

const barrierStore = useBarrierAnalysisStore()
</script>

<template>
  <div class="barrier-results-widget">
    <div class="barrier-results-column">
      <!-- Lista barriere -->
      <div v-if="barrierStore.barriers.length > 0" class="card barrier-list">
        <div class="card-header">
          <i class="mdi mdi-format-list-bulleted me-2" />
          Lista barriere
        </div>
        <ul class="list-group list-group-flush">
          <li v-for="b in barrierStore.barriers" :key="b.id" class="list-group-item d-flex align-items-center gap-2">
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
              @click="barrierStore.zoomToBarrier(b.id)"
            >
              <i class="mdi mdi-magnify-plus-outline" />
            </button>
            <button
              type="button"
              class="btn btn-outline-danger barrier-action-btn"
              :aria-label="'Elimina ' + b.label"
              @click="barrierStore.deleteBarrier(b.id)"
            >
              <i class="mdi mdi-trash-can-outline" />
            </button>
          </li>
          <li class="list-group-item list-group-item-primary fw-bold d-flex align-items-center gap-2">
            <span class="flex-grow-1">Totale</span>
            <span class="barrier-row-metric text-primary">
              <i class="mdi mdi-close-octagon-outline" />{{ barrierStore.blockedCount }}
            </span>
            <span class="barrier-row-metric text-danger">
              <i class="mdi mdi-map-marker-off-outline" />{{ barrierStore.disconnectedCount }}
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
    </div>

    <div class="barrier-results-column">
      <!-- Log Messages -->
      <div v-if="barrierStore.logMessages.length > 0" class="card widget-log">
        <div class="card-header">
          <i class="mdi mdi-text-box-outline me-2" />
          Registro operazioni
        </div>
        <ul class="list-group list-group-flush log-entries">
          <li v-for="(msg, idx) in barrierStore.logMessages" :key="idx" class="list-group-item log-entry">
            {{ msg }}
          </li>
        </ul>
      </div>
      <p v-else class="alert alert-info py-2 px-3 mb-0 d-flex align-items-center gap-2">
        <i class="mdi mdi-information-outline me-1" />
        Nessuna operazione registrata
      </p>
    </div>
  </div>
</template>

<style src="./BarrierResults.css" scoped></style>
