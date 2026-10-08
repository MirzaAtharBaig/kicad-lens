import type { BBox, Change, LayerView, RevisionView, SheetView } from '@kicad-lens/protocol';
import { svgBlobUrl } from './host';
import { layerColor, stackOrder } from './layers';
import { PX_PER_MM } from './viewport';

export interface LayerState {
  visible: boolean;
  opacity: number;
}

export interface StageContext {
  sheetId?: string;
  layers: Map<string, LayerState>;
  flipped: boolean;
}

export const OVERLAY = { unchanged: '#8a8a8a', removed: '#e5484d', added: '#30a46c' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, style?: Partial<CSSStyleDeclaration>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  return e;
}

export function sheetOf(rev: RevisionView | undefined, id: string | undefined): SheetView | undefined {
  return rev?.sheets?.find((s) => s.id === id);
}

export function pageSize(rev: RevisionView | undefined, ctx: StageContext): { width: number; height: number } {
  const s = sheetOf(rev, ctx.sheetId);
  return s ? { width: s.width, height: s.height } : (rev?.page ?? { width: 297, height: 210 });
}

function sizeStage(stage: HTMLElement, size: { width: number; height: number }): void {
  stage.style.width = `${size.width * PX_PER_MM}px`;
  stage.style.height = `${size.height * PX_PER_MM}px`;
}

/**
 * Alpha filters for overlay layers. Anti-aliased strokes never cancel exactly:
 * an unchanged line of coverage `a` leaves `a·(1−a)` (≤ 0.25) behind in a
 * subtract mask, which at low zoom tints every line. `kl-cut` drops that residue;
 * `kl-boost` restores the `a·a` coverage of the intersect (unchanged) layer.
 */
function ensureFilters(): void {
  if (document.getElementById('kl-filters')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'kl-filters';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  // Static markup, no user data.
  svg.innerHTML = `
    <filter id="kl-cut" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncA type="linear" slope="1.8" intercept="-0.45"/></feComponentTransfer></filter>
    <filter id="kl-boost" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent="0.5" offset="0"/></feComponentTransfer></filter>`;
  document.body.append(svg);
}

/** Full-size layer whose colour shows through an alpha mask built from one or two SVGs. */
function maskLayer(color: string, opacity: number, a: string, b?: string, op?: 'intersect' | 'subtract'): HTMLElement {
  const d = el('div', 'fill', { backgroundColor: color });
  // Filters run before masking on the same element, so they go on a wrapper.
  const wrap = el('div', 'fill', { opacity: String(opacity) });
  wrap.append(d);
  if (op) {
    ensureFilters();
    wrap.classList.add(op === 'subtract' ? 'aa-cut' : 'aa-boost');
  }
  const urls = [a, b].filter((u): u is string => !!u);
  Promise.all(urls.map(svgBlobUrl))
    .then((blobs) => {
      const v = blobs.map((u) => `url("${u}")`).join(', ');
      d.style.setProperty('mask-image', v);
      d.style.setProperty('-webkit-mask-image', v);
      if (op) {
        d.style.setProperty('mask-composite', op);
        d.style.setProperty('-webkit-mask-composite', op === 'intersect' ? 'source-in' : 'source-out');
      }
    })
    .catch(() => d.classList.add('load-error'));
  return wrap;
}

function imageLayer(url: string): HTMLElement {
  const img = el('img', 'fill');
  img.alt = '';
  img.draggable = false;
  svgBlobUrl(url)
    .then((u) => (img.src = u))
    .catch(() => img.classList.add('load-error'));
  return img;
}

function missing(text: string): HTMLElement {
  const d = el('div', 'missing');
  d.textContent = text;
  return d;
}

function orderedLayers(layers: LayerView[], ctx: StageContext): LayerView[] {
  return layers
    .filter((l) => l.svgUrl && ctx.layers.get(l.name)?.visible)
    .sort((a, b) => stackOrder(a.name, ctx.flipped) - stackOrder(b.name, ctx.flipped));
}

/** Normal rendering of one revision. */
export function buildRevision(stage: HTMLElement, rev: RevisionView | undefined, ctx: StageContext): void {
  stage.replaceChildren();
  sizeStage(stage, pageSize(rev, ctx));
  if (!rev) return void stage.append(missing('Not present in this revision'));
  if (rev.kind === 'sch') {
    const s = sheetOf(rev, ctx.sheetId);
    const paper = el('div', 'paper fill');
    stage.append(paper);
    if (!s) paper.append(missing('Sheet not present in this revision'));
    else if (!s.svgUrl) paper.append(missing('kicad-cli produced no output for this sheet'));
    else paper.append(imageLayer(s.svgUrl));
  } else {
    const board = el('div', 'board fill');
    stage.append(board);
    for (const l of orderedLayers(rev.layers ?? [], ctx))
      board.append(maskLayer(layerColor(l.name), ctx.layers.get(l.name)?.opacity ?? 1, l.svgUrl!));
  }
}

/**
 * Overlay diff: unchanged grey, removed red, added green.
 * `half` limits it to one side, as in a side-by-side diff: `before` shows
 * unchanged + removed, `after` shows unchanged + added.
 */
export function buildOverlay(
  stage: HTMLElement,
  before: RevisionView | undefined,
  after: RevisionView | undefined,
  ctx: StageContext,
  half?: 'before' | 'after',
): void {
  stage.replaceChildren();
  sizeStage(stage, pageSize(after ?? before, ctx));
  const kind = (after ?? before)?.kind;
  const showRemoved = half !== 'after';
  const showAdded = half !== 'before';
  const triple = (parent: HTMLElement, a?: string, b?: string, opacity = 1) => {
    if (a && b) {
      parent.append(maskLayer(OVERLAY.unchanged, 0.75 * opacity, a, b, 'intersect'));
      if (showRemoved) parent.append(maskLayer(OVERLAY.removed, opacity, a, b, 'subtract'));
      if (showAdded) parent.append(maskLayer(OVERLAY.added, opacity, b, a, 'subtract'));
    } else if (a && showRemoved) parent.append(maskLayer(OVERLAY.removed, opacity, a));
    else if (b && showAdded) parent.append(maskLayer(OVERLAY.added, opacity, b));
  };
  if (kind === 'sch') {
    const paper = el('div', 'paper fill');
    stage.append(paper);
    const sb = sheetOf(before, ctx.sheetId);
    const sa = sheetOf(after, ctx.sheetId);
    if (half === 'before' && !sb) paper.append(missing('Sheet not present in this revision'));
    if (half === 'after' && !sa) paper.append(missing('Sheet not present in this revision'));
    triple(paper, sb?.maskUrl ?? sb?.svgUrl, sa?.maskUrl ?? sa?.svgUrl);
  } else {
    const board = el('div', 'board overlay fill');
    stage.append(board);
    const names = new Map<string, LayerView>();
    for (const l of [...(before?.layers ?? []), ...(after?.layers ?? [])]) names.set(l.name, l);
    for (const l of orderedLayers([...names.values()], ctx)) {
      const op = Math.max(0.5, ctx.layers.get(l.name)?.opacity ?? 1);
      triple(board, before?.layers?.find((x) => x.name === l.name)?.svgUrl, after?.layers?.find((x) => x.name === l.name)?.svgUrl, op);
    }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Annotations {
  changes: Change[];
  selected?: string;
  links?: { bbox: BBox; target: string }[];
  flash?: BBox;
  onLink?: (target: string) => void;
  /** Only draw boxes that belong to this revision (one pane of a side-by-side view). */
  side?: 'before' | 'after';
  /** Draw only the selected change's boxes. */
  onlySelected?: boolean;
}

/**
 * Net changes point at every part on the net, duplicating the component boxes;
 * they are only drawn while selected.
 */
const BOX_ONLY_WHEN_SELECTED = new Set(['net']);

/** Change boxes, child-sheet links and search highlights, in page millimetres. */
export function buildAnnotations(stage: HTMLElement, size: { width: number; height: number }, ctx: StageContext, a: Annotations): void {
  stage.querySelector(':scope > svg.annotations')?.remove();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('annotations', 'fill');
  svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const groups = new Map<string, SVGGElement>();
  const group = (side?: 'before' | 'after') => {
    const key = side ?? 'both';
    let g = groups.get(key);
    if (!g) {
      g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-side', key); // applyBlend() fades old/new boxes with the slider
      svg.append(g);
      groups.set(key, g);
    }
    return g;
  };
  const rect = (b: BBox, cls: string, parent: SVGElement = svg) => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(b.minX));
    r.setAttribute('y', String(b.minY));
    r.setAttribute('width', String(Math.max(b.maxX - b.minX, 0.5)));
    r.setAttribute('height', String(Math.max(b.maxY - b.minY, 0.5)));
    r.setAttribute('class', cls);
    parent.append(r);
    return r;
  };
  for (const l of a.links ?? []) {
    const r = rect(l.bbox, 'link');
    r.addEventListener('dblclick', () => a.onLink?.(l.target));
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = 'Double-click to open sheet';
    r.append(t);
  }
  for (const c of a.changes) {
    const isSelected = c.id === a.selected;
    if (!isSelected && (a.onlySelected || BOX_ONLY_WHEN_SELECTED.has(c.category))) continue;
    for (const loc of c.locations) {
      if (!loc.bbox) continue;
      if (loc.sheet !== undefined && loc.sheet !== ctx.sheetId) continue;
      if (loc.layer !== undefined && ctx.layers.size && !ctx.layers.get(loc.layer)?.visible) continue;
      if (a.side && loc.side && loc.side !== a.side) continue;
      rect(loc.bbox, `chg ${c.kind}${loc.side === 'before' ? ' old' : ''}${isSelected ? ' selected' : ''}`, group(loc.side));
    }
  }
  if (a.flash) rect(a.flash, 'flash');
  stage.append(svg);
}
