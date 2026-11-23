// Interactive equaliser graph. The curves are computed by the native engine
// from the real filter coefficients, so what you see is what is applied.
import { PointerEvent, ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { EQ_FREQUENCIES, SoundSettings } from '../../shared/types';
import { SpectrumView } from './Visualizer';
import { fmt } from './Controls';

let W = 1000;
const H = 300;
const DB = 15;
const POINTS = 220;
const FREQS = Array.from({ length: POINTS }, (_, i) => 20 * Math.pow(1000, i / (POINTS - 1)));
const xOf = (f: number) => (Math.log(f / 20) / Math.log(1000)) * W;
const yOf = (db: number) => H / 2 - (db / DB) * (H / 2 - 14);
const dbOf = (y: number) => ((H / 2 - y) / (H / 2 - 14)) * DB;

function path(values: number[]) {
  return values.map((v, i) => `${i ? 'L' : 'M'}${xOf(FREQS[i]).toFixed(1)},${yOf(Math.max(-DB, Math.min(DB, v))).toFixed(1)}`).join(' ');
}

export function EqGraph({
  sound,
  onBandChange,
  deviceCorrection,
}: {
  sound: SoundSettings;
  onBandChange: (band: number, gain: number) => void;
  deviceCorrection: boolean;
}) {
  const [local, setLocal] = useState<number[] | null>(null);
  const gains = local ?? sound.eqGainsDb;
  const [userCurve, setUserCurve] = useState<number[]>(() => FREQS.map(() => 0));
  const [totalCurve, setTotalCurve] = useState<number[]>(() => FREQS.map(() => 0));
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(300, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  W = width;
  const drag = useRef<number | null>(null);
  const reqId = useRef(0);

  const key = JSON.stringify([gains, sound.bassDb, sound.midDb, sound.trebleDb, sound.eqEnabled, sound.eqQ, deviceCorrection]);
  useEffect(() => {
    const id = ++reqId.current;
    const patch = { eqGainsDb: gains };
    Promise.all([api.getResponse(FREQS, patch, false), deviceCorrection ? api.getResponse(FREQS, patch, true) : Promise.resolve(null)])
      .then(([u, t]) => {
        if (id !== reqId.current) return;
        setUserCurve(u);
        setTotalCurve(t ?? u);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toLocal = (e: PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return ((e.clientY - rect.top) / rect.height) * H;
  };
  const onDown = (band: number) => (e: PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = band;
    setLocal([...sound.eqGainsDb]);
  };
  const onMove = (e: PointerEvent) => {
    if (drag.current === null || !local) return;
    const g = Math.round(Math.max(-12, Math.min(12, dbOf(toLocal(e)))) * 2) / 2;
    if (g === local[drag.current]) return;
    const next = [...local];
    next[drag.current] = g;
    setLocal(next);
    onBandChange(drag.current, g);
  };
  const onUp = () => {
    drag.current = null;
    setTimeout(() => setLocal(null), 250);
  };

  const grid = useMemo(() => {
    const lines: ReactElement[] = [];
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      lines.push(<line key={`f${f}`} x1={xOf(f)} x2={xOf(f)} y1={0} y2={H} className="eq-grid" />);
      lines.push(
        <text key={`t${f}`} x={xOf(f) + 4} y={H - 6} className="eq-axis">
          {f >= 1000 ? `${f / 1000}k` : f}
        </text>,
      );
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      lines.push(<line key={`d${db}`} x1={0} x2={W} y1={yOf(db)} y2={yOf(db)} className={db === 0 ? 'eq-zero' : 'eq-grid'} />);
      lines.push(
        <text key={`dt${db}`} x={6} y={yOf(db) - 4} className="eq-axis">
          {db > 0 ? `+${db}` : db}
        </text>,
      );
    }
    return lines;
  }, [width]);

  return (
    <div className="eq-graph">
      <div className="eq-spectrum">
        <SpectrumView height={300} showOriginal={false} compact />
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp}>
        <defs>
          <linearGradient id="eqStroke" x1="0" x2="1">
            <stop offset="0%" stopColor="var(--accent-a)" />
            <stop offset="100%" stopColor="var(--accent-b)" />
          </linearGradient>
          <linearGradient id="eqFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-a)" stopOpacity="0.35" />
            <stop offset="50%" stopColor="var(--accent-a)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--accent-b)" stopOpacity="0.25" />
          </linearGradient>
        </defs>
        {grid}
        {deviceCorrection && <path d={path(totalCurve)} className="eq-total" />}
        <path d={`${path(userCurve)} L${W},${H / 2} L0,${H / 2} Z`} fill="url(#eqFill)" className="eq-area" />
        <path d={path(userCurve)} className="eq-curve" stroke="url(#eqStroke)" />
        {EQ_FREQUENCIES.map((f, i) => (
          <g key={f} className={`eq-node ${drag.current === i ? 'active' : ''}`} onPointerDown={onDown(i)} onDoubleClick={() => onBandChange(i, 0)}>
            <line x1={xOf(f)} x2={xOf(f)} y1={yOf(0)} y2={yOf(gains[i])} className="eq-stem" />
            <circle cx={xOf(f)} cy={yOf(gains[i])} r={16} className="eq-hit" />
            <circle cx={xOf(f)} cy={yOf(gains[i])} r={7} className="eq-dot" />
          </g>
        ))}
      </svg>
      <div className="eq-legend">
        <span>
          <i className="sw user" /> Your EQ (engine response)
        </span>
        {deviceCorrection && (
          <span>
            <i className="sw total" /> With device correction
          </span>
        )}
        <span className="hint">Drag points · double-click to reset a band · {fmt.db(gains.reduce((m, g) => Math.max(m, g), -99))} max</span>
      </div>
    </div>
  );
}
