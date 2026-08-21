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
    // @arcgis/core and calcite-components lazily import many internal chunks at
    // runtime (e.g. Sketch's DrawTool/plugins) that Vite's dep scanner can't see
    // ahead of time. Letting the dev server pre-bundle them mid-session causes a
    // re-optimize that invalidates URLs the page already loaded, surfacing as
    // "Outdated Optimize Dep" 504s and failed dynamic imports. Excluding them lets
    // the browser load their already-published ESM directly instead.
    exclude: ['@arcgis/core', '@arcgis/map-components', '@esri/calcite-components'],
  },
})