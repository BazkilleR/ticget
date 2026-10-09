import { useEffect, useRef, useState } from 'react';

// Data colours are categorical slots 1-2 of the dataviz reference palette (validated: CVD ΔE 24.7, both
// >= 3:1 on white). Status colours (success/warning/danger) stay reserved for states, never for data.
// Text never takes a series colour; the marks beside it carry the identity.

const BAR_MAX = 24;
const RADIUS = 4;
const AXIS_W = 52;
const LABEL_H = 22;
const TOP_PAD = 10;

const thaiNumber = (n) => n.toLocaleString('th-TH');

// "12K", "1.5M": short axis labels. Tooltips and tables always show the full number.
function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Smallest 1/2/5 x 10^k at or above max, so gridlines land on round numbers.
function niceMax(max) {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max);
}

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// Column with a rounded data end and a square foot on the baseline.
function columnPath(x, y, w, base) {
  const r = Math.min(RADIUS, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/**
 * Single-series column chart. data: [{ key, label, value }]. formatValue renders full values (tooltip,
 * table); name is the series name shown in the tooltip and table header.
 * Every value is reachable without hovering through the "ดูเป็นตาราง" table.
 */
export function BarChart({ data, name, formatValue = thaiNumber, height = 220, tableLabel = 'วันที่' }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [active, setActive] = useState(null);

  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [0, max / 2, max];
  const innerW = Math.max(0, width - AXIS_W);
  const base = height - LABEL_H;
  const plotH = base - TOP_PAD;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(BAR_MAX, band - 2, band * 0.62));
  // Thin the x labels so they never collide (~56px each).
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 56))));
  const y = (v) => base - (v / max) * plotH;
  const hovered = active !== null ? data[active] : null;

  return (
    <div className="chart">
      <div className="chart-plot" ref={ref} style={{ height }} onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${name} ตาม${tableLabel}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} />
                <text className="chart-axis" x={AXIS_W - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compact(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = AXIS_W + band * i + band / 2;
              return (
                <g key={d.key}>
                  {d.value > 0 && (
                    <path
                      className={`chart-bar${active === i ? ' is-active' : ''}`}
                      d={columnPath(cx - barW / 2, y(d.value), barW, base)}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text className="chart-axis" x={cx} y={height - 6} textAnchor="middle">
                      {d.label}
                    </text>
                  )}
                  {/* The whole band is the hit target, bigger than the bar, and keyboard reachable. */}
                  <rect
                    className="chart-hit"
                    x={AXIS_W + band * i}
                    y={TOP_PAD}
                    width={band}
                    height={plotH}
                    tabIndex={0}
                    aria-label={`${d.label}: ${formatValue(d.value)}`}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  />
                </g>
              );
            })}
            <line className="chart-baseline" x1={AXIS_W} x2={width} y1={base} y2={base} />
          </svg>
        )}
        {hovered && (
          <div
            className="chart-tooltip"
            style={{
              left: Math.min(Math.max(AXIS_W + band * active + band / 2, 70), width - 70),
              top: Math.max(0, y(hovered.value) - 8),
            }}
          >
            <strong>{formatValue(hovered.value)}</strong>
            <span>
              <i className="chart-key" aria-hidden="true" />
              {name} · {hovered.label}
            </span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>ดูเป็นตาราง</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{tableLabel}</th>
                <th className="num">{name}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <td>{d.label}</td>
                  <td className="num">{formatValue(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// Sold (slot 1) and held (slot 2) as one stacked bar, separated by a 2px surface gap. The exact numbers
// are always printed beside it, so nothing depends on telling the colours apart.
export function SoldBar({ sold, held, capacity }) {
  const pct = (n) => (capacity ? Math.min(100, (n / capacity) * 100) : 0);
  return (
    <div className="sold-bar" title={`ขายแล้ว ${thaiNumber(sold)} · รอชำระ ${thaiNumber(held)} · ความจุ ${thaiNumber(capacity)}`}>
      <span className="sold-bar-track">
        {sold > 0 && <span className="sold-bar-sold" style={{ width: `${pct(sold)}%` }} />}
        {held > 0 && <span className="sold-bar-held" style={{ width: `${pct(held)}%` }} />}
      </span>
      <span className="sold-bar-label">
        {thaiNumber(sold)} / {thaiNumber(capacity)}
      </span>
    </div>
  );
}

export function SoldLegend() {
  return (
    <p className="chart-legend">
      <span>
        <i className="legend-swatch legend-sold" aria-hidden="true" />
        ขายแล้ว
      </span>
      <span>
        <i className="legend-swatch legend-held" aria-hidden="true" />
        รอชำระ
      </span>
      <span>
        <i className="legend-swatch legend-free" aria-hidden="true" />
        ว่าง
      </span>
    </p>
  );
}

export function StatTile({ label, value, note }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}
