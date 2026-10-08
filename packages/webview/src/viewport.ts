import type { BBox, Viewport } from '@kicad-lens/protocol';

/** Base resolution of the stage: CSS pixels per millimetre at scale 1. */
export const PX_PER_MM = 4;

/**
 * Pan/zoom controller. The stage is laid out in millimetres × PX_PER_MM and
 * moved with a CSS transform; `scale` is screen pixels per millimetre.
 */
export class PanZoom {
  view: Viewport = { cx: 0, cy: 0, scale: 1 };
  private listeners: ((v: Viewport, user: boolean) => void)[] = [];
  private flipped = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly stages: () => HTMLElement[],
  ) {
    host.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    host.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    new ResizeObserver(() => this.apply(false)).observe(host);
  }

  onChange(fn: (v: Viewport, user: boolean) => void): void {
    this.listeners.push(fn);
  }

  setFlipped(f: boolean): void {
    this.flipped = f;
    this.apply(false);
  }

  set(v: Viewport, user = false): void {
    this.view = { ...v, scale: Math.min(Math.max(v.scale, 0.05), 2000) };
    this.apply(user);
  }

  fit(box: BBox, margin = 0.05): void {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(box.maxX - box.minX, 1);
    const h = Math.max(box.maxY - box.minY, 1);
    const scale = Math.min(r.width / (w * (1 + 2 * margin)), r.height / (h * (1 + 2 * margin)));
    this.set({ cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 }, true);
  }

  zoomBy(factor: number, sx?: number, sy?: number): void {
    const r = this.host.getBoundingClientRect();
    const px = sx ?? r.width / 2;
    const py = sy ?? r.height / 2;
    const before = this.toPage(px, py);
    const scale = Math.min(Math.max(this.view.scale * factor, 0.05), 2000);
    // Keep the point under the cursor fixed.
    const dir = this.flipped ? -1 : 1;
    const cx = before.x - (dir * (px - r.width / 2)) / scale;
    const cy = before.y - (py - r.height / 2) / scale;
    this.set({ cx, cy, scale }, true);
  }

  /** Screen (host-relative) → page mm. */
  toPage(sx: number, sy: number): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    const dir = this.flipped ? -1 : 1;
    return { x: this.view.cx + (dir * (sx - r.width / 2)) / this.view.scale, y: this.view.cy + (sy - r.height / 2) / this.view.scale };
  }

  apply(user: boolean): void {
    const r = this.host.getBoundingClientRect();
    const k = this.view.scale / PX_PER_MM;
    const sx = this.flipped ? -k : k;
    const tx = r.width / 2 - this.view.cx * this.view.scale * (this.flipped ? -1 : 1);
    const ty = r.height / 2 - this.view.cy * this.view.scale;
    const t = `translate(${tx}px, ${ty}px) scale(${sx}, ${k})`;
    for (const s of this.stages()) s.style.transform = t;
    for (const l of this.listeners) l(this.view, user);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.host.getBoundingClientRect();
    if (e.ctrlKey || !e.shiftKey) {
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomBy(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
    } else {
      this.set({ ...this.view, cx: this.view.cx + e.deltaY / this.view.scale }, true);
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest('.no-pan')) return;
    const start = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy };
    let moved = false;
    this.host.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      this.host.classList.add('panning');
      const dir = this.flipped ? -1 : 1;
      this.set({ ...this.view, cx: start.cx - (dir * dx) / this.view.scale, cy: start.cy - dy / this.view.scale }, true);
    };
    const up = () => {
      this.host.classList.remove('panning');
      this.host.removeEventListener('pointermove', move);
      this.host.removeEventListener('pointerup', up);
      this.host.removeEventListener('pointercancel', up);
    };
    this.host.addEventListener('pointermove', move);
    this.host.addEventListener('pointerup', up);
    this.host.addEventListener('pointercancel', up);
  }
}
