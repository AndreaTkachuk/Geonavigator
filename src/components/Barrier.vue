<script setup lang="ts">
import { ref } from 'vue'

const isExpanded = ref(false)

</script>

<template>
  <div class="barrier-widget-panel">
    <h3>Analisi isolamento stradale</h3>
    <p>Crea barriere (punto/linea/poligono) per identificare insediamenti isolati</p>
    <!-- We'll add controls here -->
  </div>
</template>

<style scoped>
.barrier-widget-panel {
  padding: 16px;
  background: white;
}
</style>