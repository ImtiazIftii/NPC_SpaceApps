import { useMemo, useState } from "react"
import { formatNumber, longDayToDate, severityNames } from "../data/fireData"
import type { DailyRecord, Horizon } from "../types"

type Props = {
  rows: DailyRecord[][]
  horizon: Horizon
  selectedYear?: number
  onSelectYear?: (year: number, day?: number) => void
  onHorizon?: (horizon: Horizon) => void
}

const colors = [
  "var(--data-0)",
  "var(--data-1)",
  "var(--data-2)",
  "var(--data-3)",
  "var(--data-4)",
]

export default function HistoricalCalendar({
  rows,
  horizon,
  selectedYear,
  onSelectYear,
  onHorizon,
}: Props) {
  const [selected, setSelected] = useState<DailyRecord | null>(null)
  const [mode, setMode] = useState<"daily" | "horizon">("daily")
  const reversed = useMemo(() => [...rows].reverse(), [rows])

  // Precompute annual metrics for each year
  const annualData = useMemo(() => {
    return reversed.map((row) => {
      const yr = row[0]?.year ?? 0
      const totalCount = row.reduce((sum, r) => sum + (r.count || 0), 0)
      const strongest = row.reduce(
        (best, r) => (r.zScore > best.zScore ? r : best),
        row[0],
      )
      const criticalDays = row.filter((r) => r.zScore > 2 || r.criticalRun).length
      return {
        row,
        year: yr,
        totalCount,
        strongest,
        criticalDays,
      }
    })
  }, [reversed])

  const maxAnnualCount = useMemo(() => {
    return Math.max(...annualData.map((d) => d.totalCount), 1)
  }, [annualData])

  // Active record for inspector and highlighting (falls back to selectedYear)
  const currentRecord = useMemo(() => {
    if (selected && (!selectedYear || selected.year === selectedYear)) {
      return selected
    }
    if (selectedYear) {
      const match = annualData.find((d) => d.year === selectedYear)
      if (match?.strongest) return match.strongest
    }
    return selected || (annualData[0]?.strongest ?? null)
  }, [selected, selectedYear, annualData])

  const currentAnnualInfo = useMemo(() => {
    if (!currentRecord) return null
    return annualData.find((d) => d.year === currentRecord.year) || null
  }, [currentRecord, annualData])

  const handleHorizonClick = () => {
    if (mode !== "horizon") {
      setMode("horizon")
    } else {
      // If already in horizon mode, cycle horizon: 23 -> 10 -> 5 -> 23
      const nextHorizon: Horizon = horizon === 23 ? 10 : horizon === 10 ? 5 : 23
      onHorizon?.(nextHorizon)
    }
  }

  const handleDailyClick = () => {
    setMode("daily")
  }

  return (
    <section className="data-section calendar-section">
      <div className="section-title-row">
        <div>
          <span className="section-kicker">Historical record</span>
          <h2>Burning calendar</h2>
        </div>
        <div className="micro-segment">
          <button
            data-active={mode === "daily"}
            onClick={handleDailyClick}
            type="button"
          >
            Daily
          </button>
          <button
            data-active={mode === "horizon"}
            onClick={handleHorizonClick}
            title="Switch to multi-year annual baseline view (click again to cycle horizon)"
            type="button"
          >
            {horizon}y
          </button>
        </div>
      </div>

      {mode === "daily" ? (
        <>
          <div className="calendar-months">
            {"JFMAMJJASOND".split("").map((month, index) => (
              <span key={`${month}-${index}`}>{month}</span>
            ))}
          </div>
          <div className="compact-calendar">
            {reversed.map((row) => {
              const yr = row[0].year
              const isSelected = yr === (currentRecord?.year ?? selectedYear)
              const gradient = row
                .map(
                  (record, index) =>
                    `${colors[record.severity]} ${(index / 364) * 100}%`,
                )
                .join(",")
              return (
                <button
                  className={`calendar-line ${isSelected ? "selected-year-row" : ""}`}
                  data-selected={isSelected}
                  key={yr}
                  onClick={() => {
                    const strongest = row.reduce((best, record) =>
                      record.zScore > best.zScore ? record : best,
                    )
                    setSelected(strongest)
                    onSelectYear?.(yr, strongest.day)
                  }}
                  style={{
                    background: `linear-gradient(90deg, ${gradient})`,
                    outline: isSelected ? "2px solid #ef4444" : undefined,
                    boxShadow: isSelected
                      ? "0 0 8px rgba(239, 68, 68, 0.6)"
                      : undefined,
                  }}
                  type="button"
                >
                  <span>{yr}</span>
                </button>
              )
            })}
          </div>
        </>
      ) : (
        <>
          <div className="annual-header">
            <span className="annual-header-label">
              {horizon}y Record · Annual Footprint
            </span>
            {onHorizon && (
              <div className="annual-horizon-pills">
                {([5, 10, 23] as Horizon[]).map((h) => (
                  <button
                    data-active={horizon === h}
                    key={h}
                    onClick={(e) => {
                      e.stopPropagation()
                      onHorizon(h)
                    }}
                    type="button"
                  >
                    {h}y
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="annual-calendar">
            {annualData.map((item) => {
              const isSelected = item.year === (currentRecord?.year ?? selectedYear)
              const pct = Math.max(
                8,
                Math.min(
                  100,
                  Math.round((item.totalCount / maxAnnualCount) * 100),
                ),
              )
              const peakSev = item.strongest.severity
              const sevColor = colors[peakSev]
              return (
                <button
                  className={`annual-row ${isSelected ? "selected-year-row" : ""}`}
                  data-selected={isSelected}
                  key={item.year}
                  onClick={() => {
                    setSelected(item.strongest)
                    onSelectYear?.(item.year, item.strongest.day)
                  }}
                  style={{
                    outline: isSelected ? "2px solid #ef4444" : undefined,
                    boxShadow: isSelected
                      ? "0 0 8px rgba(239, 68, 68, 0.6)"
                      : undefined,
                  }}
                  type="button"
                >
                  <span className="annual-yr">{item.year}</span>
                  <div className="annual-track">
                    <div
                      className="annual-fill"
                      style={{
                        width: `${pct}%`,
                        background: `linear-gradient(90deg, var(--data-0) 0%, ${sevColor} 100%)`,
                      }}
                    />
                  </div>
                  <div className="annual-meta">
                    <span className="annual-count">
                      {formatNumber(item.totalCount)}
                    </span>
                    <span className="annual-sigma" style={{ color: sevColor }}>
                      {item.strongest.zScore >= 0 ? "+" : ""}
                      {item.strongest.zScore.toFixed(1)}σ
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="calendar-inspector">
        {mode === "horizon" && currentAnnualInfo ? (
          <>
            <span>
              {currentAnnualInfo.year} Annual Record · Peak:{" "}
              {longDayToDate(
                currentAnnualInfo.strongest.day,
                currentAnnualInfo.year,
              )}
            </span>
            <strong>{formatNumber(currentAnnualInfo.totalCount)}</strong>
            <small>
              {currentAnnualInfo.criticalDays} critical anomaly days ·{" "}
              {severityNames[currentAnnualInfo.strongest.severity]} ·{" "}
              {currentAnnualInfo.strongest.zScore >= 0 ? "+" : ""}
              {currentAnnualInfo.strongest.zScore.toFixed(1)}σ
            </small>
          </>
        ) : currentRecord ? (
          <>
            <span>{longDayToDate(currentRecord.day, currentRecord.year)}</span>
            <strong>{formatNumber(currentRecord.count)}</strong>
            <small>
              {severityNames[currentRecord.severity]} ·{" "}
              {currentRecord.zScore >= 0 ? "+" : ""}
              {currentRecord.zScore.toFixed(1)}σ
            </small>
          </>
        ) : (
          <small>
            {mode === "horizon"
              ? "Select a year to inspect its annual record"
              : "Select a year to inspect its strongest anomaly"}
          </small>
        )}
      </div>
    </section>
  )
}
