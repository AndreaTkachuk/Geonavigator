// ─── Типи конфігурації (аналог environment.model.ts) ──────────────────────────
// Структура відповідає config.json з Angular-проекту

export interface AppConfig {
  version: string
  debug: boolean
  baseHref: string
  themes: Record<string, string>         // { "data-theme": "light" }
  applicationSettings: ApplicationSettings
  map: MapConfig
}

export interface ApplicationSettings {
  titlePage: string
  titleApplication: string
  portalUrl: string
  appId: string
  geometryService: string
  formatDate: string
  enableActionDirectionPopup: boolean
  nameWidgetDirections: string
  hiddenParameters: boolean
  esriLocalLibs: boolean
  listExcludeFieldsPopup: string[]

  preload: {
    active: boolean
    background?: string
  }

  login?: {
    active: boolean
  }

  logo?: {
    light: LogoVariant
    dark: LogoVariant
  }

  topmenu?: {
    active: boolean
    links: TopMenuLink[]
  }

  proxy?: {
    proxyUrl: string
    [key: string]: string               // додаткові версії proxyUrl_*
  }

  viewerManagerConfigPath?: string

  exportMap?: {
    defaultBasemap: {
      url: string
      title: string
      opacity: number
      visible: boolean
    }
  }
}

export interface LogoVariant {
  lg?: { url: string }
  md?: { url: string }
  sm?: { url: string }
}

export interface TopMenuLink {
  label: string
  icon: string
  urlManuale?: string
  urlServerMail?: Record<string, string>
}

// ─── Конфіг карти ─────────────────────────────────────────────────────────────
export interface MapConfig {
  viewer: ViewerConfig       // desktop
  viewerMobile: ViewerConfig // mobile
}

export interface ViewerConfig {
  mapId: MapIdItem[]
  type: '2D' | '3D'
  viewCustom: ViewCustomObject[]
  settings: MapSettings
  widgets: WidgetConfig[]
  layers: LayerConfig[]
  table?: { config: string }
}

export interface MapIdItem {
  type: '2D' | '3D'
  id: string
  [key: string]: string     // id_*, інші варіанти
}

export interface MapSettings {
  tilt?: number
  heading?: number
  basemap?: string
  basemapDark?: string
  mode?: 'desktop' | 'mobile'
  useFeature?: boolean
  zoom?: number
  center?: [number, number]
  extent?: Record<string, number>
  rotation?: number
  timeExtent?: Record<string, string>
  baseMapLayers?: any
  ground?: {
    layers: Array<{ url: string }>
  }
  id?: string
  camera?: any
}

export interface ViewCustomObject {
  id: string
  class?: string[]
  style?: Record<string, string>
}

// ─── Конфіг віджету ───────────────────────────────────────────────────────────
export interface WidgetConfig {
  name?: string
  customWidget?: boolean
  lazyLoading?: boolean
  visible?: boolean
  draggable?: boolean
  resizable?: boolean
  position?: string
  mapType?: '2D' | '3D'
  customStyle?: string | Record<string, string>
  cssUrl?: string
  config?: string | Record<string, any>

  expandConfig?: {
    _openAtStart?: boolean | string
    openAtStart?: boolean
    titleCustom?: boolean
    helpCustom?: string
    expandIcon?: string
    expandTooltip?: string
    group?: string
  }

  containerPosition?: {
    top?: string
    left?: string
    right?: string
    bottom?: string
  }

  containerSize?: {
    width?: string
    height?: string
  }

  titleOver?: string
  expandTooltip?: string
  expandTooltipReset?: string

  // Групований віджет (аналог viewGroupCustom)
  viewGroupCustom?: {
    id: string
    visible: boolean
    helpCustom?: string
    expandIcon?: string
    expandTooltip?: string
    group?: string
    widgets: WidgetConfig[]
  }
}

// ─── Конфіг шару ──────────────────────────────────────────────────────────────
export interface LayerConfig {
  id?: string
  type?: string
  url?: string
  title?: string
  visible?: boolean
  opacity?: number
  [key: string]: any
}