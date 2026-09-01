// @arcgis/core non fornisce un .d.ts per geometry/projectionUtils (modulo interno, non piu' documentato
// come geometry/projection nelle versioni 4.x): dichiarazione minima per le sole funzioni usate qui.
declare module '@arcgis/core/geometry/projectionUtils' {
  import type Geometry from '@arcgis/core/geometry/Geometry'
  import type Point from '@arcgis/core/geometry/Point'
  import type Polyline from '@arcgis/core/geometry/Polyline'
  import type SpatialReference from '@arcgis/core/geometry/SpatialReference'

  export function load(): Promise<void>
  export function isLoaded(): boolean
  export function project(
    geometry: Point,
    outSpatialReference: SpatialReference | { wkid: number }
  ): Point
  export function project(
    geometry: Polyline,
    outSpatialReference: SpatialReference | { wkid: number }
  ): Polyline
  export function project(
    geometries: Polyline[],
    outSpatialReference: SpatialReference | { wkid: number }
  ): Polyline[]
  export function project(
    geometry: Geometry,
    outSpatialReference: SpatialReference | { wkid: number }
  ): Geometry
}
