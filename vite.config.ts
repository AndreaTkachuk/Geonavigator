import { defineConfig, type Connect, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

const BASE = '/Geonavigator/'

// Vite risolve base/index.html solo se il path richiesto termina esattamente con lo slash finale
// configurato: "/Geonavigator" (senza slash) non fa match e restituisce 404 prima ancora di
// raggiungere la SPA, mentre "/Geonavigator/map" funziona (fallback SPA su rotte annidate). Un link
// condiviso senza slash finale altrimenti sembra rotto: qui lo si redirige alla versione corretta.
function redirectMissingTrailingSlash(): Plugin {
  const bareBase = BASE.replace(/\/$/, '')

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? ''
    const queryIndex = url.indexOf('?')
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
    const query = queryIndex === -1 ? '' : url.slice(queryIndex)

    if (pathname === bareBase) {
      res.statusCode = 301
      res.setHeader('Location', BASE + query)
      res.end()
      return
    }
    next()
  }

  return {
    name: 'redirect-missing-trailing-slash',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  base: BASE,
  plugins: [
    redirectMissingTrailingSlash(),
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