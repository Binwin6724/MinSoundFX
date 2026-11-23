// Real-time visualisers drawn on canvas from the engine's analysis stream
// (no React re-renders per frame).
import { useEffect, useRef } from 'react';
import { analysis } from '../api';

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const loop = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawRef.current(ctx, w, h, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return ref;
}

const DB_MIN = -96;
const DB_MAX = 0;

function smoothPath(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i][0] + pts[i + 1][0]) / 2;
    const yc = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

export function SpectrumView({ height = 260, showOriginal = true, compact = false }: { height?: number; showOriginal?: boolean; compact?: boolean }) {
  const smoothOut = useRef<Float32Array | null>(null);
  const smoothIn = useRef<Float32Array | null>(null);
  const peaks = useRef<Float32Array | null>(null);
  const lastT = useRef(0);

  const ref = useCanvas((ctx, w, h, t) => {
    const dt = Math.min(0.1, (t - lastT.current) / 1000 || 0.016);
    lastT.current = t;
    const a = analysis.latest;
    const fresh = a && performance.now() - analysis.receivedAt < 500;
    const bands = a?.bands ?? 72;
    if (!smoothOut.current || smoothOut.current.length !== bands) {
      smoothOut.current = new Float32Array(bands).fill(DB_MIN);
      smoothIn.current = new Float32Array(bands).fill(DB_MIN);
      peaks.current = new Float32Array(bands).fill(DB_MIN);
    }
    const so = smoothOut.current, si = smoothIn.current!, pk = peaks.current!;
    const fall = 60 * dt; // dB per frame-time
    for (let i = 0; i < bands; i++) {
      const vo = fresh && a?.processed ? Math.max(DB_MIN, a.processed[i]) : DB_MIN;
      const vi = fresh && a?.original ? Math.max(DB_MIN, a.original[i]) : DB_MIN;
      so[i] = vo > so[i] ? so[i] + (vo - so[i]) * 0.6 : Math.max(vo, so[i] - fall);
      si[i] = vi > si[i] ? si[i] + (vi - si[i]) * 0.6 : Math.max(vi, si[i] - fall);
      pk[i] = so[i] > pk[i] ? so[i] : Math.max(DB_MIN, pk[i] - 18 * dt);
    }

    const accentA = cssVar('--accent-a') || '#7c5cff';
    const accentB = cssVar('--accent-b') || '#22d3ee';
    const grid = cssVar('--grid') || 'rgba(255,255,255,0.06)';
    const muted = cssVar('--text-faint') || '#667';
    const padB = compact ? 4 : 18;
    const ph = h - padB;
    const y = (db: number) => ph - ((Math.min(DB_MAX, db) - DB_MIN) / (DB_MAX - DB_MIN)) * ph;

    if (!compact) {
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = muted;
      ctx.font = '10px ui-sans-serif, system-ui';
      for (const db of [-72, -48, -24]) {
        ctx.beginPath();
        ctx.moveTo(0, y(db));
        ctx.lineTo(w, y(db));
        ctx.stroke();
        ctx.fillText(`${db}`, 4, y(db) - 3);
      }
      const freqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
      for (const f of freqs) {
        const x = (Math.log(f / 20) / Math.log(1000)) * w;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x - 8, h - 4);
      }
    }

    const pts = (arr: Float32Array): Array<[number, number]> =>
      Array.from(arr, (v, i) => [(i + 0.5) * (w / bands), y(v)] as [number, number]);

    if (!fresh && so.every((v) => v <= DB_MIN + 0.5)) return;
    // Processed: gradient-filled area with a glowing edge.
    const po = pts(so);
    const fill = ctx.createLinearGradient(0, 0, w, 0);
    fill.addColorStop(0, accentA);
    fill.addColorStop(1, accentB);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, ph);
    ctx.lineTo(po[0][0], po[0][1]);
    smoothPath(ctx, po);
    ctx.lineTo(w, ph);
    ctx.closePath();
    const vfade = ctx.createLinearGradient(0, 0, 0, ph);
    vfade.addColorStop(0, 'rgba(255,255,255,0.55)');
    vfade.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.28;
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = vfade;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, po);
    ctx.strokeStyle = fill;
    ctx.lineWidth = compact ? 1.5 : 2.2;
    ctx.shadowColor = accentB;
    ctx.shadowBlur = compact ? 6 : 14;
    ctx.stroke();
    ctx.restore();

    if (!compact) {
      ctx.fillStyle = accentB;
      ctx.globalAlpha = 0.7;
      for (let i = 0; i < bands; i += 1) {
        if (pk[i] <= DB_MIN + 1) continue;
        ctx.fillRect((i + 0.5) * (w / bands) - 1.5, y(pk[i]) - 1, 3, 2);
      }
      ctx.globalAlpha = 1;
    }

    if (showOriginal && a?.meters && a.meters.wetMix > 0.01) {
      const pi = pts(si);
      ctx.save();
      ctx.beginPath();
      smoothPath(ctx, pi);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = cssVar('--text-muted') || '#999';
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  });

  return <canvas ref={ref} className="viz-canvas" style={{ height }} />;
}

export function WaveformView({ height = 70 }: { height?: number }) {
  const ref = useCanvas((ctx, w, h) => {
    const a = analysis.latest;
    const fresh = a && performance.now() - analysis.receivedAt < 500;
    const data = fresh ? a?.waveform : undefined;
    const accentA = cssVar('--accent-a') || '#7c5cff';
    const accentB = cssVar('--accent-b') || '#22d3ee';
    const mid = h / 2;
    ctx.strokeStyle = cssVar('--grid') || 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    if (!data || !data.length) return;
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    const gain = peak > 0 ? Math.min(6, 0.9 / peak) : 1; // auto-scale for visibility
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, accentA);
    grad.addColorStop(1, accentB);
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const yv = mid - data[i] * gain * (h / 2 - 2);
      if (i === 0) ctx.moveTo(x, yv);
      else ctx.lineTo(x, yv);
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = accentA;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
  });
  return <canvas ref={ref} className="viz-canvas" style={{ height }} />;
}

const toDb = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -120);

/** Vertical peak/RMS meters per channel with peak hold. */
export function LevelMeters({ height = 180, labels }: { height?: number; labels?: string[] }) {
  const hold = useRef<number[]>([]);
  const disp = useRef<number[]>([]);
  const ref = useCanvas((ctx, w, h) => {
    const m = analysis.latest?.meters;
    const fresh = m && performance.now() - analysis.receivedAt < 500;
    const n = Math.max(2, m?.peaks.length ?? 2);
    const gap = 6;
    const bw = Math.min(16, (w - gap * (n - 1) - 24) / n);
    const total = n * bw + (n - 1) * gap;
    const x0 = (w - total) / 2 + 10;
    const top = 4, bottom = h - 16;
    const range = 60;
    const yOf = (db: number) => top + (Math.min(0, Math.max(-range, db)) / -range) * (bottom - top);
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.fillStyle = cssVar('--text-faint') || '#667';
    for (const db of [0, -12, -24, -48]) ctx.fillText(`${db}`, 0, yOf(db) + 3);
    const names = labels ?? (n === 2 ? ['L', 'R'] : ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lb', 'Rb']);
    for (let c = 0; c < n; c++) {
      const peakDb = fresh ? toDb(m!.peaks[c] ?? 0) : -120;
      const rmsDb = fresh ? toDb(m!.rms[c] ?? 0) : -120;
      disp.current[c] = Math.max(rmsDb, (disp.current[c] ?? -120) - 1.5);
      hold.current[c] = Math.max(peakDb, (hold.current[c] ?? -120) - 0.4);
      const x = x0 + c * (bw + gap);
      ctx.fillStyle = cssVar('--meter-bg') || 'rgba(255,255,255,0.05)';
      roundRect(ctx, x, top, bw, bottom - top, 4);
      ctx.fill();
      const grad = ctx.createLinearGradient(0, bottom, 0, top);
      grad.addColorStop(0, '#22d3ee');
      grad.addColorStop(0.7, '#7c5cff');
      grad.addColorStop(0.9, '#f59e0b');
      grad.addColorStop(1, '#ef4444');
      const yr = yOf(disp.current[c]);
      ctx.fillStyle = grad;
      roundRect(ctx, x, yr, bw, bottom - yr, 4);
      ctx.fill();
      const yp = yOf(hold.current[c]);
      ctx.fillStyle = hold.current[c] > -1.5 ? '#ef4444' : cssVar('--text') || '#fff';
      ctx.fillRect(x, yp, bw, 2);
      ctx.fillStyle = cssVar('--text-faint') || '#667';
      ctx.fillText(names[c] ?? `${c + 1}`, x + bw / 2 - 4, h - 3);
    }
  });
  return <canvas ref={ref} className="viz-canvas" style={{ height }} />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, Math.max(0, h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
