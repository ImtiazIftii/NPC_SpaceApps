import { useEffect, useMemo, useRef, useState } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { CONTINENTS, countries, dayToDate, intersectingCountries } from "../data/fireData"
import worldGeoJson from "../data/countries.geo.json"
import type { Bounds, CountryProfile, Horizon } from "../types"

type Props = {
  anomaly: number
  country: CountryProfile | null
  bounds: Bounds
  horizon: Horizon
  day: number
  year: number
  onCountry: (country: CountryProfile | null) => void
  onBounds: (bounds: Bounds, preset?: string, multiplier?: number) => void
  onDay: (day: number) => void
  onYear: (year: number) => void
  onHorizon: (horizon: Horizon) => void
}

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
const EPS = 0.0005

// Backend base URL. Uses relative /api in production on Render, or port 8000 in local dev
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE ||
  (typeof window !== "undefined" && window.location.port === "5173"
    ? "http://127.0.0.1:8000"
    : "")
).replace(/\/$/, "")

const FIRMS_KEY = (
  import.meta.env.VITE_FIRMS_KEY || "3190f953a2198c880c77c74397f9c6ce"
).trim()

// "World fires" mode draws at most this many dots (strongest by FRP first)
const MAX_WORLD_POINTS = 10000

// Max AOI size (square degrees) for which we request hotspot points
const MAX_HOTSPOT_AREA = 400

// Linear-time Quickselect O(N) to extract top K points by FRP without full sort
function quickselectTopK<T extends { frp: number }>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr
  let left = 0
  let right = arr.length - 1
  while (left < right) {
    const pivot = arr[right].frp
    let i = left
    for (let j = left; j < right; j++) {
      if (arr[j].frp > pivot) {
        const temp = arr[i]
        arr[i] = arr[j]
        arr[j] = temp
        i++
      }
    }
    const temp = arr[i]
    arr[i] = arr[right]
    arr[right] = temp

    if (i === k) break
    else if (i < k) left = i + 1
    else right = i - 1
  }
  return arr.slice(0, k)
}

function parseFirmsCsv(
  text: string,
  maxPoints: number,
): { pts: { lat: number; lng: number; frp: number }[]; total: number } | null {
  const firstNewline = text.indexOf("\n")
  if (firstNewline < 0) return null
  const header = text.slice(0, firstNewline)
  const cols = header.split(",")
  const iLat = cols.indexOf("latitude")
  const iLng = cols.indexOf("longitude")
  const iFrp = cols.indexOf("frp")
  if (iLat < 0 || iLng < 0) return null

  const pts: { lat: number; lng: number; frp: number }[] = []
  let start = firstNewline + 1
  const len = text.length

  while (start < len) {
    let end = text.indexOf("\n", start)
    if (end < 0) end = len
    const line = text.slice(start, end).trim()
    start = end + 1
    if (!line) continue

    let colIdx = 0
    let cStart = 0
    let lat = 0
    let lng = 0
    let frp = 0
    for (let i = 0; i <= line.length; i++) {
      if (i === line.length || line[i] === ",") {
        const val = line.slice(cStart, i)
        if (colIdx === iLat) lat = Number(val)
        else if (colIdx === iLng) lng = Number(val)
        else if (colIdx === iFrp) frp = Number(val) || 0
        colIdx++
        cStart = i + 1
      }
    }
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      pts.push({ lat, lng, frp })
    }
  }

  const total = pts.length
  const topPts = total > maxPoints ? quickselectTopK(pts, maxPoints) : pts
  return { pts: topPts, total }
}

// Keyless tile sources (Esri public tiles)
const TILES = {
  dark: {
    label: "Dark",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    maxNativeZoom: 16,
  },
  streets: {
    label: "Streets",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    maxNativeZoom: 19,
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    maxNativeZoom: 19,
  },
} as const
type TileKey = keyof typeof TILES

const toLL = (b: Bounds) =>
  L.latLngBounds([b.south, b.west], [b.north, b.east])
const fromLL = (b: L.LatLngBounds): Bounds => ({
  west: b.getWest(),
  east: b.getEast(),
  north: b.getNorth(),
  south: b.getSouth(),
})
const handlePos = (b: Bounds, h: ResizeHandle): L.LatLngTuple => [
  h.includes("n") ? b.north : h.includes("s") ? b.south : (b.north + b.south) / 2,
  h.includes("w") ? b.west : h.includes("e") ? b.east : (b.west + b.east) / 2,
]
const anomalyColor = (a: number) =>
  a >= 2 ? "#ff3d00" : a >= 1 ? "#ffb300" : "#ff7832"

// Country shapes (ISO3 in feature.id). For reliability, download this file into
// /public and point the URL at "/countries.geo.json".
const COUNTRY_SHAPES_URL =
  "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json"

const sameBounds = (a: Bounds, b: Bounds) =>
  Math.abs(a.west - b.west) < 1e-3 &&
  Math.abs(a.east - b.east) < 1e-3 &&
  Math.abs(a.north - b.north) < 1e-3 &&
  Math.abs(a.south - b.south) < 1e-3

const inBox = (lng: number, lat: number, b: Bounds) =>
  lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north

const ringHas = (ring: number[][], x: number, y: number) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// True if the country's real outline has a point inside the box, or the box
// center lies inside the country (box fully inside a big country).
const featureTouchesBox = (feature: any, b: Bounds) => {
  const g = feature.geometry
  if (!g) return false
  const polys: number[][][][] =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []
  const cx = (b.west + b.east) / 2
  const cy = (b.south + b.north) / 2
  return polys.some(
    (poly) => poly[0].some(([x, y]) => inBox(x, y, b)) || ringHas(poly[0], cx, cy),
  )
}

// Reads daily z-scores out of an /api/analysis response, tolerating a few
// shapes: [{date, z}], {date:[...], z:[...]}, or {"2020-09-14": 1.2}.
const isoDay = (v: unknown) => {
  const t = String(v ?? "")
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : ""
}
const Z_KEYS = ["z", "zscore", "z_score", "zScore", "anomaly", "sigma"]
const zKeyOf = (o: any) =>
  Z_KEYS.find((k) => o?.[k] !== null && o?.[k] !== "" && Number.isFinite(Number(o?.[k]))) ??
  Object.keys(o ?? {}).find((k) => /^z/i.test(k) && Number.isFinite(Number(o[k])))
const readDaily = (data: any): Record<string, number> => {
  const out: Record<string, number> = {}
  const daily = data?.daily
  if (Array.isArray(daily)) {
    daily.forEach((e: any) => {
      if (!e || typeof e !== "object") return
      let d = isoDay(e.date ?? e.day ?? e.time ?? e.t)
      const doy = e.doy ?? e.day_of_year
      if (!d && e.year && doy) {
        d = new Date(Date.UTC(Number(e.year), 0, Number(doy))).toISOString().slice(0, 10)
      }
      const k = zKeyOf(e)
      if (d && k) out[d] = Number(e[k])
    })
  } else if (daily && typeof daily === "object") {
    const dates = daily.date ?? daily.dates ?? daily.day
    const zs = daily.z ?? daily.zscore ?? daily.z_score ?? daily.anomaly
    if (Array.isArray(dates) && Array.isArray(zs)) {
      dates.forEach((d: any, i: number) => {
        const iso = isoDay(d)
        const z = Number(zs[i])
        if (iso && Number.isFinite(z)) out[iso] = z
      })
    } else {
      Object.entries(daily).forEach(([k, v]: [string, any]) => {
        const iso = isoDay(k)
        if (!iso) return
        const z = typeof v === "number" ? v : v && zKeyOf(v) ? Number(v[zKeyOf(v)!]) : NaN
        if (Number.isFinite(z)) out[iso] = z
      })
    }
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "")
const NAME_ALIASES: Record<string, string> = {
  unitedstates: "unitedstatesofamerica",
  tanzania: "unitedrepublicoftanzania",
  czechia: "czechrepublic",
  serbia: "republicofserbia",
  northmacedonia: "macedonia",
  bahamas: "thebahamas",
  guineabissau: "guineabissau",
}
const matchesCountry = (feature: any, c: CountryProfile) => {
  const id = String(feature.id ?? "").toUpperCase()
  if (id && (id === String(c.code).toUpperCase() || id === String(c.id).toUpperCase())) {
    return true
  }
  const fname = norm(String(feature.properties?.name ?? ""))
  const cname = norm(String(c.name))
  return fname === cname || fname === NAME_ALIASES[cname]
}

export default function AoiMap({
  anomaly,
  country,
  bounds,
  horizon,
  day,
  year,
  onCountry,
  onBounds,
  onDay,
  onYear,
  onHorizon,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.TileLayer | null>(null)
  const labelRef = useRef<L.TileLayer | null>(null)
  const cityBorderRef = useRef<L.GeoJSON | null>(null)
  const rectRef = useRef<L.Rectangle | null>(null)
  const aoiGroupRef = useRef<L.LayerGroup | null>(null)
  const handleMarkers = useRef<L.Marker[]>([])
  const shadeRef = useRef<L.GeoJSON | null>(null)
  const geoRef = useRef<any>(worldGeoJson)
  const hotspotRef = useRef<L.LayerGroup | null>(null)
  const hotspotRendererRef = useRef<L.Canvas | null>(null)
  const allShadeRef = useRef<L.GeoJSON | null>(null)
  const worldRef = useRef<L.LayerGroup | null>(null)
  const worldCacheRef = useRef<
    Map<string, { pts: { lat: number; lng: number; frp: number }[]; total: number }>
  >(new Map())
  const applyRef = useRef<(b: Bounds, skip?: number) => void>(() => {})
  const playRef = useRef<number | null>(null)
  const lastCountryRef = useRef<string | null>(country?.id ?? null)

  // latest props for handlers registered once
  const boundsRef = useRef(bounds)
  const onBoundsRef = useRef(onBounds)
  const onCountryRef = useRef(onCountry)
  const drawingRef = useRef(false)
  const customBoxVisibleRef = useRef(false)
  boundsRef.current = bounds
  onBoundsRef.current = onBounds
  onCountryRef.current = onCountry

  const [activeContinent, setActiveContinent] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [boxHovered, setBoxHovered] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [customBoxVisible, setCustomBoxVisible] = useState(false)
  customBoxVisibleRef.current = customBoxVisible
  const [tileKey, setTileKey] = useState<TileKey>("dark")
  const [zoom, setZoomState] = useState(2)
  const [cityQuery, setCityQuery] = useState("")
  const [cityStatus, setCityStatus] = useState("")
  const [geoReady, setGeoReady] = useState(true)
  const [hotspotStatus, setHotspotStatus] = useState("")
  const [view, setView] = useState<Bounds | null>(null)
  const [showAll, setShowAll] = useState(false)
  // iso date (YYYY-MM-DD) -> z-score, per country id
  const [allDaily, setAllDaily] = useState<Record<string, Record<string, number>>>({})
  const [allStatus, setAllStatus] = useState("")
  const [allNote, setAllNote] = useState("")
  const [worldFires, setWorldFires] = useState(false)
  const [worldStatus, setWorldStatus] = useState("")

  drawingRef.current = drawing

  const showCityBorder = async (name: string) => {
    const map = mapRef.current
    const query = name.trim()
    if (!map || !query) return
    setCityStatus("Searching…")
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          query,
        )}&format=json&polygon_geojson=1&limit=1`,
      )
      const results = await res.json()
      const hit = results?.[0]
      if (!hit?.geojson) {
        setCityStatus("No border found")
        return
      }
      cityBorderRef.current?.remove()
      const layer = L.geoJSON(hit.geojson, {
        style: { color: "#ffffff", weight: 1.5, fill: false, dashArray: "4 4" },
        interactive: false,
      }).addTo(map)
      cityBorderRef.current = layer
      map.flyToBounds(layer.getBounds(), { padding: [60, 60] })
      setCityStatus("")
    } catch {
      setCityStatus("Search failed")
    }
  }

  const clearCityBorder = () => {
    cityBorderRef.current?.remove()
    cityBorderRef.current = null
    setCityStatus("")
  }

  // A country preset (e.g. Chile's box) must only mean that country, even though
  // its rectangle overlaps neighbours. Only custom boxes look at other countries.
  const isPreset = useMemo(
    () => Boolean(country?.presets?.some((p) => sameBounds(p.bounds, bounds))),
    [country, bounds],
  )
  const included = useMemo(
    () => (isPreset && country ? [country] : intersectingCountries(bounds)),
    [isPreset, country, bounds],
  )
  const [shaded, setShaded] = useState<CountryProfile[]>([])

  const selectCountry = (item: CountryProfile) => {
    setCustomBoxVisible(false)
    setDrawing(false)
    onCountry(item)
    onBounds(item.presets[0].bounds, item.presets[0].name, item.presets[0].multiplier)
  }

  const deselectCustomArea = () => {
    setCustomBoxVisible(false)
    setDrawing(false)
  }

  // ---------- map init (once) ----------
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const map = L.map(host, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 19,
      zoomSnap: 0.25,
      zoomControl: false,
      worldCopyJump: true,
    })
    mapRef.current = map
    map.on("zoomend", () => setZoomState(map.getZoom()))
    const syncView = () => setView(fromLL(map.getBounds()))
    map.on("moveend", syncView)
    syncView()

    map.createPane("shadePane").style.zIndex = "340"
    // fire dots: above country shading, below the AOI box, and click-through
    // so box dragging / hover card / handles keep working
    const hotspotPane = map.createPane("hotspotPane")
    hotspotPane.style.zIndex = "360"
    hotspotPane.style.pointerEvents = "none"
    hotspotRendererRef.current = L.canvas({ pane: "hotspotPane" })

    // AOI layer group (contains bounding box rectangle and resize handles)
    const aoiGroup = L.layerGroup()
    aoiGroupRef.current = aoiGroup

    // AOI rectangle
    const rect = L.rectangle(toLL(boundsRef.current), {
      color: anomalyColor(0),
      weight: 2,
      fillOpacity: 0.08,
    }).addTo(aoiGroup)
    rectRef.current = rect
    rect.on("mouseover", () => {
      if (customBoxVisibleRef.current) setBoxHovered(true)
    })
    rect.on("mouseout", () => setBoxHovered(false))

    // 8 resize handles
    handleMarkers.current = HANDLES.map((h, index) => {
      const marker = L.marker(handlePos(boundsRef.current, h), {
        draggable: true,
        icon: L.divIcon({
          className: `aoi-handle-icon h-${h}`,
          iconSize: [12, 12],
        }),
      }).addTo(aoiGroup)
      let startB = boundsRef.current
      let cur = startB
      marker.on("dragstart", () => {
        startB = { ...boundsRef.current }
        cur = startB
      })
      marker.on("drag", () => {
        const ll = marker.getLatLng()
        const b = { ...startB }
        if (h.includes("w")) b.west = Math.min(ll.lng, startB.east - EPS)
        if (h.includes("e")) b.east = Math.max(ll.lng, startB.west + EPS)
        if (h.includes("n")) b.north = Math.max(ll.lat, startB.south + EPS)
        if (h.includes("s")) b.south = Math.min(ll.lat, startB.north - EPS)
        cur = b
        applyRef.current(b, index)
      })
      marker.on("dragend", () => onBoundsRef.current(cur, "Custom area", 1))
      return marker
    })

    applyRef.current = (b, skip) => {
      rect.setBounds(toLL(b))
      handleMarkers.current.forEach((m, i) => {
        if (i !== skip) m.setLatLng(handlePos(b, HANDLES[i]))
      })
    }

    // drag whole box
    rect.on("mousedown", (e: L.LeafletMouseEvent) => {
      if (drawingRef.current || !customBoxVisibleRef.current) return
      L.DomEvent.stopPropagation(e)
      map.dragging.disable()
      const startLL = e.latlng
      const startB = { ...boundsRef.current }
      let cur = startB
      let moved = false
      const move = (ev: L.LeafletMouseEvent) => {
        moved = true
        const dLat = ev.latlng.lat - startLL.lat
        const dLng = ev.latlng.lng - startLL.lng
        cur = {
          north: startB.north + dLat,
          south: startB.south + dLat,
          east: startB.east + dLng,
          west: startB.west + dLng,
        }
        applyRef.current(cur)
      }
      const up = () => {
        map.off("mousemove", move)
        document.removeEventListener("mouseup", up)
        map.dragging.enable()
        if (moved) onBoundsRef.current(cur, "Custom area", 1)
      }
      map.on("mousemove", move)
      document.addEventListener("mouseup", up)
    })

    // Interactive base layer allowing clicking and hovering any country on Earth
    L.geoJSON(worldGeoJson as any, {
      pane: "shadePane",
      style: {
        color: "rgba(255, 255, 255, 0.12)",
        weight: 0.8,
        fillColor: "#ffffff",
        fillOpacity: 0.01,
      },
      onEachFeature: (feature, layer) => {
        const name = feature.properties?.name || feature.id
        layer.bindTooltip(name, { sticky: true })
        layer.on({
          mouseover: (e) => {
            if (drawingRef.current) return
            const l = e.target as L.Path
            l.setStyle({
              weight: 1.5,
              color: "rgba(255, 120, 50, 0.8)",
              fillColor: "rgba(255, 120, 50, 0.15)",
              fillOpacity: 0.15,
            })
          },
          mouseout: (e) => {
            if (drawingRef.current) return
            const l = e.target as L.Path
            l.setStyle({
              weight: 0.8,
              color: "rgba(255, 255, 255, 0.12)",
              fillColor: "#ffffff",
              fillOpacity: 0.01,
            })
          },
          click: (e) => {
            if (drawingRef.current) return
            L.DomEvent.stopPropagation(e)
            const match = countries.find(
              (c) =>
                c.code === feature.id ||
                c.name.toLowerCase() === (feature.properties?.name || "").toLowerCase(),
            )
            if (match) {
              selectCountry(match)
            }
          },
        })
      },
    }).addTo(map)

    return () => {
      map.remove()
      mapRef.current = null
      aoiGroupRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- basemap ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    tileRef.current?.remove()
    const t = TILES[tileKey]
    tileRef.current = L.tileLayer(t.url, {
      attribution: t.attribution,
      maxZoom: 19,
      maxNativeZoom: t.maxNativeZoom,
    }).addTo(map)
    tileRef.current.bringToBack()
  }, [tileKey])

  // ---------- labels + borders overlay (satellite only) ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    labelRef.current?.remove()
    labelRef.current = null
    if (tileKey !== "satellite") return
    labelRef.current = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        maxNativeZoom: 19,
        attribution: "Tiles &copy; Esri",
      },
    ).addTo(map)
  }, [tileKey])

  // ---------- sync custom box layer visibility ----------
  useEffect(() => {
    const map = mapRef.current
    const group = aoiGroupRef.current
    if (!map || !group) return
    if (customBoxVisible) {
      if (!map.hasLayer(group)) {
        group.addTo(map)
      }
    } else {
      if (map.hasLayer(group)) {
        group.remove()
      }
      setBoxHovered(false)
    }
  }, [customBoxVisible])

  // ---------- sync AOI with props ----------
  useEffect(() => {
    applyRef.current(bounds)
    if (isPreset && !drawingRef.current) {
      setCustomBoxVisible(false)
    }
  }, [bounds, isPreset])

  // ---------- fire hotspots (NASA FIRMS) ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    hotspotRef.current?.remove()
    hotspotRef.current = null

    // only request the part of the AOI that is on screen
    const v = view ?? bounds
    const west = Math.max(bounds.west, v.west, -180)
    const east = Math.min(bounds.east, v.east, 180)
    const south = Math.max(bounds.south, v.south, -90)
    const north = Math.min(bounds.north, v.north, 90)
    if (east <= west || north <= south) {
      setHotspotStatus("Selected area is outside the current view")
      return
    }

    const area = (east - west) * (north - south)
    if (area > MAX_HOTSPOT_AREA) {
      setHotspotStatus("Zoom in to see fire points")
      return
    }

    const key = FIRMS_KEY
    if (!key) {
      setHotspotStatus("Missing VITE_FIRMS_KEY in .env")
      return
    }

    const dateObj = new Date(Date.UTC(year, 0, day))
    const date = dateObj.toISOString().slice(0, 10)
    const ageDays = (Date.now() - dateObj.getTime()) / 86400000
    if (ageDays < 0) {
      setHotspotStatus("No satellite data for future dates")
      return
    }
    // VIIRS starts in 2012, MODIS covers 2003-2011.
    // NRT = last ~2 months, SP = archived "standard processing".
    const sensor = year < 2012 ? "MODIS" : "VIIRS_SNPP"
    const source = `${sensor}_${ageDays < 60 ? "NRT" : "SP"}`
    const ctrl = new AbortController()

    const t = setTimeout(async () => {
      try {
        setHotspotStatus("Loading fire points…")
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/${west},${south},${east},${north}/1/${date}`
        const res = await fetch(url, { signal: ctrl.signal })
        const text = await res.text()
        const [head, ...rows] = text.trim().split("\n")
        const cols = head.split(",")
        const iLat = cols.indexOf("latitude")
        const iLng = cols.indexOf("longitude")
        const iFrp = cols.indexOf("frp")
        if (!res.ok || iLat < 0) {
          setHotspotStatus(`FIRMS: ${text.trim().slice(0, 60) || "no response"}`)
          return
        }

        const renderer = hotspotRendererRef.current ?? undefined
        const group = L.layerGroup()

        // When a country is selected and NOT in world fires mode, clip fires strictly to country polygon
        let countryRings: number[][][] | null = null
        if (country) {
          const shapes = geoRef.current?.features ?? (worldGeoJson.features as any[])
          const feat = shapes.find((f: any) => matchesCountry(f, country))
          if (feat?.geometry) {
            const g = feat.geometry
            countryRings = []
            if (g.type === "Polygon") {
              if (g.coordinates?.[0]) countryRings.push(g.coordinates[0])
            } else if (g.type === "MultiPolygon") {
              g.coordinates?.forEach((poly: any) => {
                if (poly?.[0]) countryRings!.push(poly[0])
              })
            }
          }
        }

        const parsedPts: { lat: number; lng: number; frp: number }[] = []
        for (let i = 0; i < rows.length; i++) {
          const c = rows[i].split(",")
          const lat = Number(c[iLat])
          const lng = Number(c[iLng])
          const frp = Number(c[iFrp]) || 0
          if (Number.isNaN(lat) || Number.isNaN(lng)) continue

          // Spatial clipping: if country selected, point must fall strictly inside its polygon
          if (countryRings && countryRings.length > 0) {
            const inside = countryRings.some((ring) => ringHas(ring, lng, lat))
            if (!inside) continue
          }

          parsedPts.push({ lat, lng, frp })
          if (parsedPts.length >= 5000) break
        }

        parsedPts.forEach((pt) => {
          L.circleMarker([pt.lat, pt.lng], {
            renderer,
            interactive: false,
            radius: Math.min(3 + pt.frp / 20, 9),
            color: "#ffffff",
            weight: 0.5,
            fillColor: "#ff3d00",
            fillOpacity: 0.85,
          }).addTo(group)
        })

        group.addTo(map)
        hotspotRef.current = group
        setHotspotStatus(
          parsedPts.length >= 5000
            ? `5000+ fire hotspots in ${country?.name ?? "selected area"}`
            : parsedPts.length
              ? `${parsedPts.length} fire hotspots in ${country?.name ?? "selected area"}`
              : `No fires detected in ${country?.name ?? "selected area"} on this day`,
        )
      } catch {
        if (!ctrl.signal.aborted) setHotspotStatus("Could not load fire points")
      }
    }, 400) // debounce while dragging/scrubbing

    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [bounds, view, day, year, country])

  // ---------- load country shapes once ----------
  useEffect(() => {
    let cancelled = false
    fetch(COUNTRY_SHAPES_URL)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        geoRef.current = data
        setGeoReady(true)
      })
      .catch(() => {
        if (!cancelled) setGeoReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---------- world-wide fire dots ("World fires" mode) ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    worldRef.current?.remove()
    worldRef.current = null
    if (!worldFires) {
      setWorldStatus("")
      return
    }
    const key = FIRMS_KEY
    if (!key) {
      setWorldStatus("Missing VITE_FIRMS_KEY in .env")
      return
    }
    const dateObj = new Date(Date.UTC(year, 0, day))
    const date = dateObj.toISOString().slice(0, 10)
    const ageDays = (Date.now() - dateObj.getTime()) / 86400000
    if (ageDays < 0) {
      setWorldStatus("No satellite data for future dates")
      return
    }
    const sensor = year < 2012 ? "MODIS" : "VIIRS_SNPP"
    const source = `${sensor}_${ageDays < 60 ? "NRT" : "SP"}`
    const cacheKey = `${source}:${date}`
    const ctrl = new AbortController()

    const prefetchNeighbours = (curDay: number, curYear: number) => {
      const nextDay = curDay >= 365 ? 1 : curDay + 1
      const prevDay = curDay <= 1 ? 365 : curDay - 1
      setTimeout(() => {
        fetchWorldFires(nextDay, curYear).catch(() => {})
        fetchWorldFires(prevDay, curYear).catch(() => {})
      }, 120)
    }

    const draw = (pts: { lat: number; lng: number; frp: number }[], total: number) => {
      const renderer = hotspotRendererRef.current ?? undefined
      const group = L.layerGroup()
      pts.forEach((p) => {
        L.circleMarker([p.lat, p.lng], {
          renderer,
          interactive: false,
          radius: Math.min(2 + p.frp / 40, 6),
          color: "#ffffff",
          weight: 0.3,
          fillColor: "#ff3d00",
          fillOpacity: 0.85,
        }).addTo(group)
      })
      group.addTo(map)
      worldRef.current = group
      setWorldStatus(
        total > pts.length
          ? `${total.toLocaleString()} fires worldwide · strongest ${pts.length.toLocaleString()} shown`
          : `${total.toLocaleString()} fires worldwide`,
      )
      prefetchNeighbours(day, year)
    }

    const fetchWorldFires = async (doy: number, yr: number, signal?: AbortSignal) => {
      const dObj = new Date(Date.UTC(yr, 0, doy))
      const dIso = dObj.toISOString().slice(0, 10)
      const aDays = (Date.now() - dObj.getTime()) / 86400000
      if (aDays < 0) return null
      const sens = yr < 2012 ? "MODIS" : "VIIRS_SNPP"
      const src = `${sens}_${aDays < 60 ? "NRT" : "SP"}`
      const cKey = `${src}:${dIso}`

      const mem = worldCacheRef.current.get(cKey)
      if (mem) return mem

      // 1. Try our high-speed backend proxy (/api/world-fires)
      try {
        const backendUrl = `${API_BASE}/api/world-fires?date=${dIso}&limit=${MAX_WORLD_POINTS}`
        const res = await fetch(backendUrl, { signal })
        if (res.ok) {
          const json = await res.json()
          if (Array.isArray(json.points)) {
            const data = { pts: json.points, total: json.total ?? json.points.length }
            worldCacheRef.current.set(cKey, data)
            if (worldCacheRef.current.size > 80) {
              worldCacheRef.current.delete(worldCacheRef.current.keys().next().value as string)
            }
            return data
          }
        }
      } catch (err: any) {
        if (signal?.aborted) throw err
      }

      // 2. Client-side fallback to direct NASA FIRMS if backend is unreachable
      if (!key) return null
      const directUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${src}/world/1/${dIso}`
      const res = await fetch(directUrl, { signal })
      if (!res.ok) return null
      const text = await res.text()
      const parsed = parseFirmsCsv(text, MAX_WORLD_POINTS)
      if (parsed) {
        worldCacheRef.current.set(cKey, parsed)
        if (worldCacheRef.current.size > 80) {
          worldCacheRef.current.delete(worldCacheRef.current.keys().next().value as string)
        }
      }
      return parsed
    }

    const cached = worldCacheRef.current.get(cacheKey)
    if (cached) {
      draw(cached.pts, cached.total)
      return
    }

    const t = setTimeout(async () => {
      try {
        setWorldStatus("Retrieving satellite fire hotspots…")
        const result = await fetchWorldFires(day, year, ctrl.signal)
        if (ctrl.signal.aborted) return
        if (!result) {
          setWorldStatus("No fire records available for this date")
          return
        }
        draw(result.pts, result.total)
      } catch {
        if (!ctrl.signal.aborted) setWorldStatus("Could not load world fires")
      }
    }, 150)

    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [worldFires, day, year])

  // ---------- load anomalies for every country ("All anomalies" mode) ----------
  useEffect(() => {
    if (!showAll) {
      setAllStatus("")
      return
    }
    const missing = countries.filter((c) => !allDaily[c.id])
    if (!missing.length) return
    const ctrl = new AbortController()
    const total = countries.length
    let done = total - missing.length
    let failed = 0
    let lastError = ""
    setAllStatus(`Loading anomalies ${done}/${total}…`)
    missing.forEach(async (c) => {
      try {
        const iso = /^[A-Za-z]{3}$/.test(String(c.code)) ? String(c.code) : String(c.id)
        const b = c.presets[0].bounds
        const qs = new URLSearchParams({
          country: iso.toUpperCase(),
          bbox: `${b.west},${b.south},${b.east},${b.north}`,
          year_from: String(c.firstYear ?? 2003),
          year_to: String(c.lastYear ?? 2026),
        })
        const res = await fetch(`${API_BASE}/api/analysis?${qs}`, { signal: ctrl.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        let data: any
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error("API did not return JSON (set VITE_API_BASE?)")
        }
        const byDate = readDaily(data)
        if (!Object.keys(byDate).length) {
          failed += 1
          lastError = "no z-scores found in response"
          console.warn(
            "AoiMap: could not read daily z-scores for",
            iso,
            "keys:",
            Object.keys(data ?? {}),
            "daily sample:",
            Array.isArray(data?.daily) ? data.daily[0] : data?.daily,
          )
        } else {
          setAllDaily((prev) => ({ ...prev, [c.id]: byDate }))
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          failed += 1
          lastError = String((err as Error)?.message ?? err)
          console.warn("AoiMap: anomaly request failed for", c.id, err)
        }
      } finally {
        done += 1
        if (!ctrl.signal.aborted) {
          setAllStatus(
            done < total
              ? `Loading anomalies ${done}/${total}…`
              : failed
                ? `${failed} failed: ${lastError}`
                : "",
          )
        }
      }
    })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll])

  // ---------- shade ALL countries by their anomaly ("All anomalies" mode) ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    allShadeRef.current?.remove()
    allShadeRef.current = null
    setAllNote("")
    if (!showAll || !geoRef.current) return
    const iso = new Date(Date.UTC(year, 0, day)).toISOString().slice(0, 10)
    const features: any[] = []
    countries.forEach((c) => {
      if (included.some((i) => i.id === c.id)) return // selected area has its own shading
      const z = allDaily[c.id]?.[iso]
      if (z === undefined) return
      const f = (geoRef.current.features ?? []).find((x: any) => matchesCountry(x, c))
      if (!f) return
      features.push({ ...f, properties: { ...f.properties, __z: z, __name: c.name } })
    })
    if (!features.length) {
      if (Object.keys(allDaily).length) setAllNote("No anomaly value for this date in other countries")
      return
    }
    allShadeRef.current = L.geoJSON({ type: "FeatureCollection", features } as any, {
      pane: "shadePane",
      style: (f: any) => {
        const z = f.properties.__z as number
        const color = anomalyColor(z)
        return {
          color,
          weight: 1,
          fillColor: color,
          fillOpacity: z >= 2 ? 0.6 : z >= 1 ? 0.5 : 0.2,
        }
      },
      onEachFeature: (f: any, layer: L.Layer) => {
        const z = f.properties.__z as number
        layer.bindTooltip(`${f.properties.__name}: ${z >= 0 ? "+" : ""}${z.toFixed(1)}σ`, {
          sticky: true,
        })
      },
    }).addTo(map)
  }, [showAll, allDaily, geoReady, day, year, included])

  // ---------- shade selected countries by anomaly ----------
  useEffect(() => {
    const map = mapRef.current
    const rect = rectRef.current
    if (!map || !rect) return
    shadeRef.current?.remove()
    shadeRef.current = null
    if (!country) {
      setShaded([])
      return
    }
    const color = anomalyColor(anomaly)
    const candidates = included.length ? included : [country]
    let features = (geoRef.current?.features ?? []).filter((f: any) =>
      candidates.some((c) => matchesCountry(f, c)),
    )
    if (!isPreset) {
      features = features.filter((f: any) => featureTouchesBox(f, bounds))
    }
    setShaded(
      features.length
        ? candidates.filter((c) => features.some((f: any) => matchesCountry(f, c)))
        : [],
    )
    const strokeColor = anomaly >= 2 ? "#ff3d00" : anomaly >= 1 ? "#ffb300" : "#ff7832"
    const fillColor = anomaly >= 2 ? "#ff3d00" : anomaly >= 1 ? "#ffb300" : "transparent"
    const fillOpacity = anomaly >= 2 ? 0.22 : anomaly >= 1 ? 0.12 : 0

    if (features.length) {
      shadeRef.current = L.geoJSON(
        { type: "FeatureCollection", features } as any,
        {
          pane: "shadePane",
          interactive: false,
          style: {
            color: strokeColor,
            weight: 2,
            opacity: 0.95,
            fillColor,
            fillOpacity,
          },
        },
      ).addTo(map)
    }

    // Bounding box rectangle is ONLY visible when custom area drawing is active
    if (customBoxVisibleRef.current) {
      rect.setStyle({
        color: strokeColor,
        weight: 2,
        dashArray: "",
        fillColor: strokeColor,
        fillOpacity: 0.08,
        opacity: 0.9,
      })
    } else {
      rect.setStyle({
        opacity: 0,
        fillOpacity: 0,
        weight: 0,
      })
    }
  }, [geoReady, included, isPreset, bounds, country, anomaly])

  // ---------- fly to country when it changes ----------
  useEffect(() => {
    if (!country) {
      lastCountryRef.current = null
      return
    }
    if (lastCountryRef.current === country.id) return
    lastCountryRef.current = country.id
    setCustomBoxVisible(false)
    setDrawing(false)
    mapRef.current?.flyToBounds(toLL(country.presets[0]?.bounds ?? country.bounds), {
      padding: [60, 60],
      duration: 0.8,
    })
  }, [country])

  // ---------- draw-area mode ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !drawing) return
    map.getContainer().style.cursor = "crosshair"
    let start: L.LatLng | null = null
    let cur: Bounds | null = null
    const down = (e: L.LeafletMouseEvent) => {
      start = e.latlng
      map.dragging.disable()
    }
    const move = (e: L.LeafletMouseEvent) => {
      if (!start) return
      cur = fromLL(L.latLngBounds(start, e.latlng))
      applyRef.current(cur)
    }
    const up = () => {
      if (!start) return
      start = null
      map.dragging.enable()
      if (cur && cur.east - cur.west > EPS && cur.north - cur.south > EPS) {
        onBoundsRef.current(cur, "Custom area", 1)
        setCustomBoxVisible(true)
      } else {
        applyRef.current(boundsRef.current)
        if (isPreset) {
          setCustomBoxVisible(false)
        }
      }
      setDrawing(false)
    }
    map.on("mousedown", down)
    map.on("mousemove", move)
    document.addEventListener("mouseup", up)
    return () => {
      map.off("mousedown", down)
      map.off("mousemove", move)
      document.removeEventListener("mouseup", up)
      map.dragging.enable()
      map.getContainer().style.cursor = ""
    }
  }, [drawing, isPreset])

  // ---------- play timeline ----------
  useEffect(() => {
    if (!playing) return
    playRef.current = window.setInterval(() => {
      onDay(day >= 365 ? 1 : day + 1)
    }, 130)
    return () => {
      if (playRef.current) window.clearInterval(playRef.current)
    }
  }, [playing, day, onDay])

  const anomalyKey = anomaly >= 2 ? "critical" : anomaly >= 1 ? "elevated" : "normal"

  return (
    <section
      className="primary-map"
      aria-label="Global active fire map"
      data-drawing={drawing}
    >
      <div className="leaflet-host" ref={hostRef} />

      <div className="aoi-tools strata-chrome">
        <span>Area tool</span>
        <button
          data-active={drawing || customBoxVisible}
          onClick={() => {
            if (drawing) {
              setDrawing(false)
              if (isPreset) {
                setCustomBoxVisible(false)
              }
            } else {
              setDrawing(true)
              setCustomBoxVisible(true)
            }
          }}
          type="button"
        >
          {drawing ? "Cancel drawing" : "Draw area"}
        </button>
        {customBoxVisible && (
          <button
            className="aoi-deselect-btn"
            onClick={deselectCustomArea}
            title="Deselect custom area"
            type="button"
          >
            ✕ Deselect area
          </button>
        )}
        {country ? (
          <button
            onClick={() => {
              setDrawing(false)
              setCustomBoxVisible(false)
              const p = country.presets[0]
              onBounds(p.bounds, p.name, p.multiplier)
              mapRef.current?.flyToBounds(toLL(p.bounds), { padding: [60, 60] })
            }}
            type="button"
          >
            Fit {country.code}
          </button>
        ) : (
          <button
            onClick={() => {
              setDrawing(false)
              setCustomBoxVisible(false)
              mapRef.current?.setView([20, 0], 2)
            }}
            type="button"
          >
            Fit World
          </button>
        )}
       
        <button
          data-active={worldFires}
          onClick={() => setWorldFires((v) => !v)}
          type="button"
        >
          {worldFires ? "Hide world fires" : "World fires"}
        </button>
      </div>

      <div className="basemap-switch strata-chrome">
        {(Object.keys(TILES) as TileKey[]).map((key) => (
          <button
            data-active={tileKey === key}
            key={key}
            onClick={() => setTileKey(key)}
            type="button"
          >
            {TILES[key].label}
          </button>
        ))}
        <input
          aria-label="City border search"
          onChange={(e) => setCityQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") showCityBorder(cityQuery)
          }}
          placeholder="City border…"
          style={{
            background: "#1c1c1c",
            color: "#fff",
            border: "1px solid var(--strata-line-strong)",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "12px",
            width: "120px",
          }}
          type="text"
          value={cityQuery}
        />
        <button onClick={clearCityBorder} type="button">
          Clear
        </button>
        {cityStatus && <span style={{ fontSize: "11px" }}>{cityStatus}</span>}
      </div>

      <div className="map-timebar strata-chrome">
        <div className="observation-date">
          <span>Observation date</span>
          <strong>
            {dayToDate(day, year)} {year} · DOY {String(day).padStart(3, "0")}
          </strong>
        </div>
        <div className="year-selector-pill">
          <label
            htmlFor="map-year-select"
            style={{ fontSize: "9px", textTransform: "uppercase", color: "var(--chip-color)", marginRight: "5px" }}
          >
            Year
          </label>
          <select
            id="map-year-select"
            value={year}
            onChange={(e) => onYear(Number(e.target.value))}
            style={{
              background: "#1c1c1c",
              color: "#fff",
              border: "1px solid var(--strata-line-strong)",
              borderRadius: "4px",
              padding: "3px 8px",
              fontWeight: 600,
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            {Array.from(
              { length: ((country?.lastYear ?? 2026) - (country?.firstYear ?? 2003) + 1) },
              (_, i) => (country?.lastYear ?? 2026) - i,
            ).map((y) => (
              <option key={y} value={y} style={{ background: "#111", color: "#fff" }}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="compact-segment">
          {([5, 10, 23] as Horizon[]).map((value) => (
            <button
              data-active={horizon === value}
              key={value}
              onClick={() => onHorizon(value)}
              type="button"
            >
              {value === 23 ? "23y baseline" : `${value}y baseline`}
            </button>
          ))}
        </div>
        <div className="time-scrubber">
          <span style={{ width: `${(day / 365) * 100}%` }} />
          <input
            aria-label="Day of year"
            max="365"
            min="1"
            onChange={(e) => onDay(Number(e.target.value))}
            type="range"
            value={day}
          />
          {[
            [0, "Jan"],
            [16.4, "Mar"],
            [33.1, "May"],
            [49.9, "Jul"],
            [66.8, "Sep"],
            [83.6, "Nov"],
            [100, "Dec"],
          ].map(([position, label]) => (
            <i key={String(label)} style={{ left: `${position}%` }}>
              <b>{label}</b>
            </i>
          ))}
        </div>
        <button className="map-text-button" onClick={() => setPlaying((v) => !v)} type="button">
          {playing ? "Pause" : "Play"}
        </button>
        <button className="map-text-button" onClick={() => onDay(258)} type="button">
          Reset
        </button>
      </div>

      <div className="continent-bar strata-chrome">
        <span>Continent</span>
        {CONTINENTS.map((item) => {
          const isActive = activeContinent === item.id
          return (
            <button
              data-active={isActive}
              key={item.id}
              onClick={() => {
                setActiveContinent(item.id)
                setCustomBoxVisible(false)
                setDrawing(false)
                onCountry(null)
                onBounds(item.bounds, item.name, 1.0)
                mapRef.current?.flyToBounds(toLL(item.bounds), {
                  padding: [20, 20],
                  duration: 1.0,
                })
              }}
              title={`Cover ${item.name}`}
              type="button"
            >
              {item.name}
            </button>
          )
        })}
      </div>

      <div className="zoom-control strata-chrome">
        <button aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()} type="button">
          +
        </button>
        <input
          aria-label="Map zoom"
          max="19"
          min="2"
          onChange={(e) => mapRef.current?.setZoom(Number(e.target.value))}
          step="0.25"
          type="range"
          value={zoom}
        />
        <button aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()} type="button">
          −
        </button>
      </div>

      <button
        className="world-reset strata-chrome"
        onClick={() => mapRef.current?.flyTo([20, 0], 2)}
        type="button"
      >
        View world
      </button>

      <div
        className={`aoi-hover-card strata-chrome ${boxHovered && customBoxVisible ? "visible" : ""}`}
        data-anomaly={anomalyKey}
      >
        <button
          aria-label="Deselect custom area"
          className="aoi-card-close"
          onClick={(e) => {
            e.stopPropagation()
            deselectCustomArea()
          }}
          title="Deselect area"
          type="button"
        >
          ✕
        </button>
        <span>
          {(shaded.length ? shaded : included).length > 1
            ? `${(shaded.length ? shaded : included).map((i) => i.name).join(" + ")} / aggregate AOI`
            : `${(shaded.length ? shaded : included)[0]?.name ?? (country?.name ?? "Custom area")} / selected footprint`}
        </span>
        <strong>
          {anomaly >= 2
            ? `Critical Anomaly (+${anomaly.toFixed(1)}σ)`
            : anomaly >= 1
              ? `Elevated Fire (+${anomaly.toFixed(1)}σ)`
              : `Normal Baseline (${anomaly >= 0 ? "+" : ""}${anomaly.toFixed(1)}σ)`}
        </strong>
        <small>
          {year} · DOY {String(day).padStart(3, "0")} · {bounds.south.toFixed(1)}° to{" "}
          {bounds.north.toFixed(1)}°
        </small>
      </div>

      <div className="map-legend strata-chrome">
        <span>Low</span>
        <div>
          {[0, 1, 2, 3, 4, 5].map((level) => (
            <i className={`data-level-${level}`} key={level} />
          ))}
        </div>
        <span>High</span>
        {(allStatus || allNote) && (
          <span style={{ fontSize: "11px", marginLeft: "10px" }}>{allStatus || allNote}</span>
        )}
        {(worldFires ? worldStatus : hotspotStatus) && (
          <span style={{ fontSize: "11px", marginLeft: "10px" }}>
            {worldFires ? worldStatus : hotspotStatus}
          </span>
        )}
      </div>
    </section>
  )
}
