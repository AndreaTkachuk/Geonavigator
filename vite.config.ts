import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

export default defineConfig({
  base: '/Geonavigator/',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith('arcgis-'),
        },
      },
    }),
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  optimizeDeps: {
    // @arcgis/core e calcite-components importano chunk interni a runtime che il dep scanner non vede: escluderli evita re-optimize a metà sessione ("Outdated Optimize Dep" 504) e import falliti.
    exclude: ['@arcgis/core', '@arcgis/map-components', '@esri/calcite-components'],
  },
})