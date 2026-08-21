import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

export default defineConfig({
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
})