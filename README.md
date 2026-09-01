# Geonavigatore

🔗 **Sito pubblicato**: [andreatkachuk.github.io/Geonavigator](https://andreatkachuk.github.io/Geonavigator/)

Geonavigatore e' un visualizzatore di mappe basato su ArcGIS Maps SDK for JavaScript, con un widget di **analisi di isolamento stradale**: si disegnano una o piu' barriere sulla rete viaria e l'app calcola, tramite un servizio ArcGIS Network Analyst, quali strade vengono tagliate e quali restano isolate dalla rete principale.

## Funzionalita' principali

- **Mappa 2D/3D**: toggle tra `MapView` (2D) e `SceneView` (3D) sulla stessa area, con basemap satellitare.
- **Analisi di isolamento stradale** (widget "Barrier"):
  - disegno di barriere (linee) sulla rete stradale caricata da un servizio ArcGIS FeatureServer;
  - calcolo locale delle strade fisicamente tagliate da ciascuna barriera;
  - chiamata a un servizio Network Analyst (Service Area) per determinare quali strade restano raggiungibili dalla rete principale e quali ne restano isolate;
  - evidenziazione in rosso delle sole strade isolate sulla mappa.
- **Pannello risultati** ("Risultati analisi barriere"): cassetto (drawer) agganciato al bordo inferiore della mappa, con lista barriere (conteggio strade tagliate/isolate per barriera, zoom e cancellazione) e registro operazioni.
- **Sidebar** con pannelli ad accordion per gli altri widget configurati.

## Stack tecnico

- [Vue 3](https://vuejs.org/) (`<script setup>`) + TypeScript
- [Vite](https://vitejs.dev/) come build tool e dev server
- [ArcGIS Maps SDK for JavaScript 5.xx](https://developers.arcgis.com/javascript/) (`@arcgis/core`, `@arcgis/map-components`)
- [Pinia](https://pinia.vuejs.org/) per lo stato condiviso tra widget
- [Vue Router](https://router.vuejs.org/) (modalita' `history`) per le rotte `/map`, `/map/2D`, `/map/3D`
- [Vuetify](https://vuetifyjs.com/) e [Bootstrap Italia](https://italia.github.io/bootstrap-italia/) per l'interfaccia

## Avvio del progetto

Prerequisiti: Node.js LTS e npm.

```sh
npm install
```

### Sviluppo (hot reload)

```sh
npm run start
```

Avvia il dev server di Vite (di default su `http://localhost:5173/Geonavigator/`).

### Build di produzione

```sh
npm run build
```

Esegue il type-check (`vue-tsc -b`), la build (`vite build`) e infine copia `dist/index.html` in `dist/404.html`: questo secondo passaggio serve a far funzionare le rotte dell'app (`/map`, `/map/2D`, `/map/3D`) anche quando l'utente ricarica la pagina o apre un link diretto, dato che il sito viene pubblicato su GitHub Pages, che non supporta un fallback SPA lato server.

### Anteprima della build di produzione

```sh
npm run preview
```

## Configurazione

La mappa, i basemap e i widget mostrati nella sidebar sono definiti in [`src/assets/configs/config.json`](src/assets/configs/config.json). Ogni voce sotto `map.viewer.widgets` con `position: "aside-position"` compare come pannello nella sidebar; il contenuto effettivo del pannello e' associato al suo `name` nel template di [`src/pages/ViewerPage/index.vue`](src/pages/ViewerPage/index.vue).

## Deploy

Il branch `main` viene pubblicato automaticamente su GitHub Pages tramite [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): ad ogni push viene eseguita la build e il contenuto di `dist/` viene caricato come sito statico, all'indirizzo del repository (`.../Geonavigator/`).

## Manuale utente

### Navigare la mappa

- Il pulsante **2D/3D** in alto a destra passa tra visualizzazione piana e vista tridimensionale, mantenendo la stessa area geografica e gli stessi dati caricati.
- La sidebar a sinistra elenca i pannelli disponibili; cliccando su una voce il pannello si apre con un'animazione, mantenendo lo stato anche dopo la chiusura. Il pulsante **Comprimi** in basso riduce la sidebar a sole icone.

### Analisi di isolamento stradale

1. Aprire il pannello **Analisi di isolamento stradale** nella sidebar. Al primo utilizzo l'app scarica la rete stradale dal servizio configurato: lo stato di caricamento e il numero di strade/nodi vengono mostrati nel pannello.
2. Premere **Aggiungi barriera**, quindi disegnare una linea sulla mappa cliccando due punti che attraversino una o piu' strade. La barriera si chiude automaticamente al secondo click (o si puo' annullare con **Annulla disegno**).
3. Dopo il disegno, l'app calcola in automatico:
   - le strade **tagliate** direttamente dalla barriera (evidenziate in blu tratteggiato);
   - le **junction** della rete usate come punti di verifica della connettivita' (marker neri);
   - le strade che restano **isolate** dalla rete principale, tramite chiamata al servizio Network Analyst (evidenziate in rosso).
4. Si possono disegnare piu' barriere: l'analisi si ricalcola cumulativamente su tutte quelle presenti. Spostare o eliminare una barriera direttamente sulla mappa (click sulla barriera per modificarla) aggiorna di conseguenza l'analisi.
5. Il pulsante **Ripristina** (con richiesta di conferma) rimuove tutte le barriere e riporta la mappa allo stato iniziale.

### Pannello risultati

In fondo alla mappa e' presente una barra con l'icona a elenco e il testo **Risultati analisi barriere**: cliccandola si apre un cassetto con due colonne:

- **Lista barriere**: una riga per ogni barriera disegnata, con il numero di strade tagliate e isolate e due pulsanti per fare zoom sulla barriera o eliminarla; l'ultima riga mostra i totali.
- **Registro operazioni**: log cronologico delle operazioni eseguite (caricamento dati, disegno/modifica barriere, chiamate al servizio, risultati), utile per seguire cosa succede durante analisi piu' lunghe.
