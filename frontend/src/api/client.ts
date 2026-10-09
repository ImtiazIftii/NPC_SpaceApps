/**
 * frontend/src/api/client.ts
 *
 * Connects the FireCalendar frontend to the live FastAPI backend.
 * Provides real NASA satellite climatology, sensor calibration, and anomaly detection.
 */

import { severityFor } from "../data/fireData"
import type { Bounds, CountryProfile, DailyRecord, DashboardData, Severity } from "../types"

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" && window.location.port === "5173"
    ? "http://127.0.0.1:8000"
    : "")
).replace(/\/$/, "")

export type BackendCountry = {
  iso: string
  name: string
  bbox: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
  k: number
  k_source: string
  r: number
  first_year: number
  last_year: number
  total_footprints: number
}

export type BackendTrust = {
  country: string
  k: number
  k_source: string
  r: number
  gaps: { daily?: number; weekly?: number; monthly?: number }
  quiet_ratio?: number
  busy_ratio?: number
  monthly: Array<{ month: string; modis: number; viirs_scaled: number }>
}

export type BackendAnalysis = {
  country: string
  bbox: [number, number, number, number]
  years: number[]
  doy: number[]
  heatmap: Array<Array<number | null>>
  baseline_mean: number[]
  baseline_std: number[]
  daily: {
    date: string[]
    value: number[]
    z: Array<number | null>
    unusual: boolean[]
  }
  unusual_by_year: Array<{ year: number; days: number }>
  seasons: Array<{
    year: number
    start: string | null
    peak: string | null
    end: string | null
    total: number
    source: string
  }>
  season_trend: {
    start_days_per_decade: number | null
    length_days_per_decade: number | null
  }
  critical_periods: Array<{
    year: number
    from_date: string
    to_date: string
  }>
  notes: string[]
}

const analysisCache = new Map<string, DashboardData>()

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export async function fetchBackendCountries(): Promise<BackendCountry[]> {
  const res = await fetch(`${API_BASE}/api/countries`)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching countries`)
  return res.json()
}

export async function fetchBackendTrust(iso: string): Promise<BackendTrust> {
  const res = await fetch(`${API_BASE}/api/trust?country=${encodeURIComponent(iso)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching trust for ${iso}`)
  return res.json()
}

export async function fetchBackendAnalysis(
  countryIso: string,
  bounds: Bounds,
  selectedDay = 258,
  signal?: AbortSignal,
): Promise<DashboardData> {
  // Quantize bounds to 1 decimal place so near-identical pans hit the same cache entry
  const q = (n: number) => Number(n.toFixed(1))
  const bboxStr = `${q(bounds.west)},${q(bounds.south)},${q(bounds.east)},${q(bounds.north)}`
  const cacheKey = `${countryIso}:${bboxStr}`

  // Check frontend memory cache first
  const cached = analysisCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const params = new URLSearchParams({
    country: countryIso,
    bbox: bboxStr,
    year_from: "2003",
    year_to: "2026",
  })

  const res = await fetch(`${API_BASE}/api/analysis?${params}`, { signal })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching analysis: ${await res.text()}`)
  }

  const analysis: BackendAnalysis = await res.json()
  const data = transformAnalysisToDashboard(analysis, selectedDay)
  analysisCache.set(cacheKey, data)
  return data
}

export function transformAnalysisToDashboard(
  analysis: BackendAnalysis,
  selectedDay = 258,
): DashboardData {
  // 1. Build critical run set: Set<"year-day">
  const criticalSet = new Set<string>()
  if (analysis.critical_periods) {
    for (const cp of analysis.critical_periods) {
      const [y1, m1, d1] = cp.from_date.split("-").map(Number)
      const [y2, m2, d2] = cp.to_date.split("-").map(Number)
      const startMs = Date.UTC(y1, m1 - 1, d1)
      const endMs = Date.UTC(y2, m2 - 1, d2)
      for (let t = startMs; t <= endMs; t += 86400000) {
        const dt = new Date(t)
        const yr = dt.getUTCFullYear()
        const doy =
          Math.floor((t - Date.UTC(yr, 0, 1)) / 86400000) + 1
        criticalSet.add(`${yr}-${doy}`)
      }
    }
  }

  // Maximum value for severity normalization
  const maxMean = Math.max(...(analysis.baseline_mean || [100]))
  const maxObserved = Math.max(
    ...analysis.heatmap.flatMap((row) => row.filter((v): v is number => v !== null)),
    maxMean * 1.5,
  )

  const rows: DailyRecord[][] = []

  for (let yIdx = 0; yIdx < analysis.years.length; yIdx++) {
    const year = analysis.years[yIdx]
    const heatRow = analysis.heatmap[yIdx] || []
    const row: DailyRecord[] = []

    for (let day = 1; day <= 365; day++) {
      const countVal = Math.round(heatRow[day - 1] ?? 0)
      const meanVal = Math.round(analysis.baseline_mean[day - 1] ?? 0)
      const stdVal = Math.max(1, Math.round(analysis.baseline_std[day - 1] ?? 1))
      const zVal = Number(((countVal - meanVal) / stdVal).toFixed(2))
      const isCritical = criticalSet.has(`${year}-${day}`) || zVal >= 2.0

      row.push({
        year,
        day,
        count: countVal,
        mean: meanVal,
        stdDev: stdVal,
        zScore: zVal,
        severity: severityFor(countVal, maxObserved, zVal) as Severity,
        criticalRun: isCritical,
      })
    }
    rows.push(row)
  }

  // Latest year's progression
  const current = rows[rows.length - 1] || []

  // Metric day: clamped to valid range
  const safeDay = Math.min(365, Math.max(1, selectedDay))
  const metricDay =
    current[safeDay - 1] ||
    current.reduce((best, r) => (r.zScore > best.zScore ? r : best), current[0])

  return {
    rows,
    current,
    metricDay,
  }
}
