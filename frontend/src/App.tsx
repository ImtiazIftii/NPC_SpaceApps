import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import AoiMap from "./components/AoiMap"
import CalibrationDialog from "./components/CalibrationDialog"
import CommandBar from "./components/CommandBar"
import HistoricalCalendar from "./components/HistoricalCalendar"
import IntelligencePanel from "./components/IntelligencePanel"
import {
  WORLD_PROFILE,
  countries,
  generateAreaDashboardData,
  rowsForHorizon,
} from "./data/fireData"
import { fetchBackendAnalysis, fetchBackendTrust } from "./api/client"
import type { Bounds, CountryProfile, DashboardData, Horizon, ThemeId } from "./types"

export default function App() {
  const shellRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ start: number; width: number } | null>(null)
  const [country, setCountry] = useState<CountryProfile | null>(null)
  const [horizon, setHorizon] = useState<Horizon>(23)
  const [day, setDay] = useState(258)
  const [year, setYear] = useState<number>(2024)
  const [theme, setTheme] = useState<ThemeId>(() =>
    localStorage.getItem("firecalendar-theme") === "paper" ? "paper" : "ember",
  )
  const [bounds, setBounds] = useState<Bounds>({ north: 85, south: -85, west: -180, east: 180 })
  const [aoiMultiplier, setAoiMultiplier] = useState(1)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [backendData, setBackendData] = useState<DashboardData | null>(null)
  const [backendTrust, setBackendTrust] = useState<{ k: number; r: number } | null>(null)

  useEffect(() => {
    localStorage.setItem("firecalendar-theme", theme)
    document.documentElement.classList.toggle("dark", theme === "ember")
  }, [theme])

  // Fetch real trust calibration metrics for current country
  useEffect(() => {
    if (!country) {
      setBackendTrust(null)
      return
    }
    let active = true
    fetchBackendTrust(country.code)
      .then((trust) => {
        if (!active) return
        setBackendTrust({ k: trust.k, r: trust.r })
      })
      .catch(() => {
        // Fallback silently if offline
      })
    return () => {
      active = false
    }
  }, [country?.code])

  // Fetch real backend analysis for selected country and bounding box
  useEffect(() => {
    if (!country) {
      setBackendData(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchBackendAnalysis(country.code, bounds, day, controller.signal)
        .then((realData) => {
          setBackendData(realData)
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            // keep fallback
          }
        })
    }, 150) // 150ms debounce for smooth dragging

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [country?.code, bounds, day])

  // Enhanced country profile with live measured k and r
  const activeCountry = useMemo(() => {
    if (!country) return null
    if (!backendTrust) return country
    return {
      ...country,
      calibration: backendTrust.k,
      correlation: backendTrust.r,
    }
  }, [country, backendTrust])

  // Use real backend data if loaded, otherwise fallback to local generator
  const data = useMemo(() => {
    const effectiveProfile = activeCountry || WORLD_PROFILE
    const source =
      backendData && backendData.current.length >= 365
        ? backendData
        : generateAreaDashboardData(effectiveProfile, bounds, aoiMultiplier)

    // Find the row for the selected year
    const yearRow = source.rows.find((r) => r[0].year === year) || source.current
    const safeDay = Math.min(365, Math.max(1, day))
    const metricDay = yearRow[safeDay - 1] || yearRow[0]

    return {
      ...source,
      current: yearRow,
      metricDay,
    }
  }, [backendData, activeCountry, bounds, aoiMultiplier, year, day])

  const visibleRows = useMemo(
    () => rowsForHorizon(data, horizon),
    [data, horizon],
  )

  const handleCountry = useCallback(
    (next: CountryProfile | null) => {
      setCountry(next)
      if (next) {
        setBounds(next.presets[0]?.bounds ?? next.bounds)
        setAoiMultiplier(next.presets[0]?.multiplier ?? 1)
        const maxYear = next.lastYear ?? 2026
        if (year > maxYear) {
          setYear(maxYear)
        }
      } else {
        setBounds({ north: 85, south: -85, west: -180, east: 180 })
        setAoiMultiplier(1)
      }
    },
    [year],
  )

  const handleBounds = useCallback(
    (next: Bounds, _preset = "Custom area", multiplier = 1) => {
      setBounds(next)
      setAoiMultiplier(multiplier)
    },
    [],
  )

  const handlePreset = (index: number) => {
    if (!country) return
    const preset = country.presets[index]
    setBounds(preset.bounds)
    setAoiMultiplier(preset.multiplier)
  }

  const handleYearSelect = (newYear: number, newDay?: number) => {
    setYear(newYear)
    if (newDay) setDay(newDay)
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <a className="skip-link" href="#analysis-panel">
        Skip to analysis
      </a>
      <CommandBar onTheme={setTheme} theme={theme} />
      <main className="strata-layout" ref={shellRef}>
        <aside className="analysis-panel strata-scroll" id="analysis-panel">
          <IntelligencePanel
            country={activeCountry}
            data={data}
            onCountry={handleCountry}
            onIntegrity={() => setCalibrationOpen(true)}
            onPreset={handlePreset}
          />
          <HistoricalCalendar
            horizon={horizon}
            rows={visibleRows}
            selectedYear={year}
            onSelectYear={handleYearSelect}
            onHorizon={setHorizon}
          />
        </aside>
        <div
          aria-label="Resize analysis panel"
          className="panel-resizer"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            const current = parseFloat(
              getComputedStyle(shellRef.current!).getPropertyValue(
                "--left-width",
              ),
            )
            resizeRef.current = {
              start: event.clientX,
              width: Number.isFinite(current) ? current : 500,
            }
          }}
          onPointerMove={(event) => {
            if (!resizeRef.current || !shellRef.current) return
            const next = Math.min(
              680,
              Math.max(
                400,
                resizeRef.current.width +
                  event.clientX -
                  resizeRef.current.start,
              ),
            )
            shellRef.current.style.setProperty("--left-width", `${next}px`)
          }}
          onPointerUp={() => {
            resizeRef.current = null
          }}
          role="separator"
        />
        <div className="visual-panel">
          <AoiMap
            anomaly={data.metricDay.zScore}
            bounds={bounds}
            country={activeCountry}
            day={day}
            year={year}
            horizon={horizon}
            onBounds={handleBounds}
            onCountry={handleCountry}
            onDay={setDay}
            onYear={setYear}
            onHorizon={setHorizon}
          />
        </div>
      </main>
      <CalibrationDialog
        country={activeCountry || WORLD_PROFILE}
        onClose={() => setCalibrationOpen(false)}
        open={calibrationOpen}
      />
    </div>
  )
}
