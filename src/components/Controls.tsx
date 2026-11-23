// Interactive controls: toggle, slider, rotary knob, segmented picker.
import { KeyboardEvent, PointerEvent, ReactNode, useEffect, useRef, useState, WheelEvent } from 'react';
import { useThrottledCommit } from '../api';

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

interface RangeProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label?: string;
  disabled?: boolean;
  bipolar?: boolean;
}

/** Keeps a local value while the user drags, committing at frame rate. */
function useLiveValue(value: number, onChange: (v: number) => void) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  const commit = useThrottledCommit(onChange);
  const update = (v: number) => {
    setLocal(v);
    commit(v);
  };
  return { local, update, dragging };
}

export function Slider({ value, min, max, step = 0.1, defaultValue, onChange, format, label, disabled, bipolar }: RangeProps) {
  const { local, update, dragging } = useLiveValue(value, onChange);
  const pct = ((local - min) / (max - min)) * 100;
  const zero = bipolar ? ((0 - min) / (max - min)) * 100 : 0;
  const lo = Math.min(pct, zero);
  const hi = Math.max(pct, zero);
  return (
    <div className={`slider ${disabled ? 'disabled' : ''}`}>
      {label && (
        <div className="slider-head">
          <span>{label}</span>
          <span className="value">{format ? format(local) : local.toFixed(1)}</span>
        </div>
      )}
      <div className="slider-track-wrap">
        <div className="slider-track">
          <div className="slider-fill" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={local}
          disabled={disabled}
          aria-label={label}
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={() => (dragging.current = false)}
          onDoubleClick={() => defaultValue !== undefined && update(defaultValue)}
          onChange={(e) => update(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

export function Knob({
  value,
  min,
  max,
  step = 0.01,
  defaultValue,
  onChange,
  format,
  label,
  disabled,
  size = 76,
  bipolar,
}: RangeProps & { size?: number }) {
  const { local, update, dragging } = useLiveValue(value, onChange);
  const start = useRef<{ y: number; v: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const norm = (local - min) / (max - min);
  const a0 = -135, a1 = 135;
  const angle = a0 + norm * (a1 - a0);
  const r = size / 2 - 7;
  const c = size / 2;
  const arc = (from: number, to: number) => {
    const rad = (d: number) => ((d - 90) * Math.PI) / 180;
    const x1 = c + r * Math.cos(rad(from)), y1 = c + r * Math.sin(rad(from));
    const x2 = c + r * Math.cos(rad(to)), y2 = c + r * Math.sin(rad(to));
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`;
  };
  const zeroAngle = bipolar ? a0 + ((0 - min) / (max - min)) * (a1 - a0) : a0;

  const onPointerDown = (e: PointerEvent) => {
    if (disabled) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, v: local };
    dragging.current = true;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!start.current) return;
    const fine = e.shiftKey ? 0.2 : 1;
    const dv = ((start.current.y - e.clientY) / 160) * (max - min) * fine;
    update(clamp(start.current.v + dv));
  };
  const onPointerUp = () => {
    start.current = null;
    dragging.current = false;
  };
  const onWheel = (e: WheelEvent) => {
    if (disabled) return;
    update(clamp(local - Math.sign(e.deltaY) * (max - min) * 0.02));
  };
  const onKey = (e: KeyboardEvent) => {
    const big = (max - min) * 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') update(clamp(local + (e.shiftKey ? big : step * 5)));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') update(clamp(local - (e.shiftKey ? big : step * 5)));
    else return;
    e.preventDefault();
  };

  return (
    <div className={`knob ${disabled ? 'disabled' : ''}`}>
      <svg
        width={size}
        height={size}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={local}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => defaultValue !== undefined && update(defaultValue)}
        onWheel={onWheel}
        onKeyDown={onKey}
      >
        <defs>
          <linearGradient id="knobGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent-a)" />
            <stop offset="100%" stopColor="var(--accent-b)" />
          </linearGradient>
        </defs>
        <path d={arc(a0, a1)} className="knob-track" />
        {Math.abs(angle - zeroAngle) > 0.5 && <path d={arc(Math.min(zeroAngle, angle), Math.max(zeroAngle, angle))} className="knob-value" />}
        <circle cx={c} cy={c} r={r - 9} className="knob-body" />
        <line
          x1={c + (r - 20) * Math.sin((angle * Math.PI) / 180)}
          y1={c - (r - 20) * Math.cos((angle * Math.PI) / 180)}
          x2={c + (r - 12) * Math.sin((angle * Math.PI) / 180)}
          y2={c - (r - 12) * Math.cos((angle * Math.PI) / 180)}
          className="knob-pointer"
        />
      </svg>
      <div className="knob-value-label">{format ? format(local) : local.toFixed(2)}</div>
      {label && <div className="knob-label">{label}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  small,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const fmt = {
  db: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
  pct: (v: number) => `${Math.round(v * 100)}%`,
  hz: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} kHz` : `${Math.round(v)} Hz`),
  ms: (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`,
  ratio: (v: number) => `${v.toFixed(1)}:1`,
  lufs: (v: number) => `${v.toFixed(0)} LUFS`,
  width: (v: number) => `${Math.round(v * 100)}%`,
  balance: (v: number) => (Math.abs(v) < 0.01 ? 'Center' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`),
};
