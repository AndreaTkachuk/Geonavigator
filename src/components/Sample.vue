<script setup lang="ts">
import { ref } from 'vue'

const isExpanded = ref(false)

</script>

<template>
  <div class="sample-widget-panel">
    <h3>Sample widget</h3>
    <p>Crea qualcosa di bello</p>
    <!-- We'll add controls here -->
  </div>
</template>

<style scoped>
.sample-widget-panel {
  padding: 16px;
  background: white;
}
</style>