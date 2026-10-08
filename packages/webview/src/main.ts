import type { BBox, Change, DiffMode, HostMessage, ItemView, RevisionView, Viewport } from '@kicad-lens/protocol';
import { handleFetchResult, post, vscode } from './host';
import { defaultOpacity, defaultVisible, layerColor } from './layers';
import { type LayerState, type StageContext, buildAnnotations, buildOverlay, buildRevision, pageSize, sheetOf } from './stage';
import { PanZoom } from './viewport';
import './styles.css';

type Show = Extract<HostMessage, { type: 'show' }>;

interface Persisted {
  sheetId?: string;
  mode?: DiffMode;
  viewport?: Viewport;
  layers?: [string, LayerState][];
  flipped?: boolean;
  showChanges?: boolean;
  showChangesPaired?: boolean;
  /** Change boxes on the drawing: every change, or only the selected one. */
  boxes?: 'all' | 'selected';
  onlyCurrent?: boolean;
}

const persisted: Persisted = vscode.getState<Persisted>() ?? {};
const save = (p: Partial<Persisted>) => {
  Object.assign(persisted, p);
  vscode.setState(persisted);
};

let show: Show | undefined;
let mode: DiffMode = 'overlay';
let blend = 0.5;
let selected: string | undefined;
let flash: BBox | undefined;
const ctx: StageContext = { layers: new Map(), flipped: false };
let panes: { el: HTMLElement; stage: HTMLElement; pz: PanZoom; label: HTMLElement }[] = [];
let lastViewport: Viewport | undefined;
let syncing = false;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

// ---------------------------------------------------------------------------
// Messages

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      return renderStatus(m.message, true);
    case 'error':
      return renderError(m.message, m.actions ?? []);
    case 'show':
      return onShow(m);
    case 'viewport':
      if (m.sheet && m.sheet !== ctx.sheetId && show?.after.sheets?.some((s) => s.id === m.sheet)) setSheet(m.sheet, false);
      if (m.flipped !== undefined && m.flipped !== ctx.flipped) setFlipped(m.flipped, false);
      syncing = true;
      for (const p of panes) p.pz.set(m.viewport);
      syncing = false;
      return;
    case 'navigateChange':
      return navigate(m.direction);
    case 'fetchResult':
      return handleFetchResult(m);
  }
});

window.addEventListener('focus', () => post({ type: 'focus', focused: true }));
window.addEventListener('blur', () => post({ type: 'focus', focused: false }));
post({ type: 'ready' });

function renderStatus(message: string, spinner: boolean): void {
  document.body.replaceChildren(h('div', { class: 'status-screen' }, ...(spinner ? [h('div', { class: 'spinner' })] : []), h('div', {}, message)));
}

function renderError(message: string, actions: { label: string; command: string }[]): void {
  const box = h('div', { class: 'status-screen error' }, h('div', { class: 'error-title' }, 'KiCad Lens could not render this file'), h('pre', {}, message));
  const row = h('div', { class: 'actions' });
  for (const a of actions) {
    const b = h('button', {}, a.label);
    b.onclick = () => post({ type: 'command', command: a.command });
    row.append(b);
  }
  box.append(row);
  document.body.replaceChildren(box);
}

// ---------------------------------------------------------------------------
// Layout

function onShow(m: Show): void {
  const first = !show;
  show = m;
  mode = m.mode === 'diff' && !m.pairedWith ? (persisted.mode ?? m.diffMode) : 'overlay';
  const rev = m.after;
  if (rev.kind === 'sch') {
    const ids = rev.sheets?.map((s) => s.id) ?? [];
    // Re-shows keep the current sheet; a fresh diff opens on the first changed sheet.
    const order = first
      ? m.mode === 'diff'
        ? [m.initialSheet, ...changedSheets(), persisted.sheetId]
        : [persisted.sheetId, m.initialSheet]
      : [ctx.sheetId, m.initialSheet, ...changedSheets()];
    const want = [...order, ids[0]].find((s) => s && (ids.includes(s) || m.before?.sheets?.some((x) => x.id === s)));
    ctx.sheetId = want ?? ids[0];
  } else {
    const saved = new Map(persisted.layers ?? []);
    const all = new Map<string, string>();
    for (const l of [...(m.before?.layers ?? []), ...(rev.layers ?? [])]) all.set(l.name, l.name);
    ctx.layers = new Map([...all.keys()].map((n) => [n, saved.get(n) ?? { visible: defaultVisible(n), opacity: defaultOpacity(n) }]));
    ctx.flipped = persisted.flipped ?? false;
  }
  buildLayout();
  rebuild();
  if (first && persisted.viewport) for (const p of panes) p.pz.set(persisted.viewport);
  else fit();
}

/** This webview is one side of VS Code's built-in side-by-side diff. */
function paired(): boolean {
  return !!show?.pairedWith && show.mode === 'diff';
}

function changes(): Change[] {
  return show?.changes ?? [];
}

function changedSheets(): string[] {
  return [...new Set(changes().flatMap((c) => c.locations.map((l) => l.sheet).filter((s): s is string => !!s)))];
}

function buildLayout(): void {
  const m = show!;
  const isDiff = m.mode === 'diff';
  const isPcb = m.after.kind === 'pcb';

  const toolbar = h('div', { class: 'toolbar' });
  toolbar.append(h('span', { class: 'title', title: m.title }, m.title));
  if (isDiff && !paired()) {
    const seg = h('div', { class: 'segmented', role: 'tablist' });
    for (const [id, label] of [['overlay', 'Overlay'], ['sideBySide', 'Side by side'], ['blend', 'Blend'], ['swipe', 'Swipe']] as const) {
      const b = h('button', { 'data-mode': id, title: label }, label);
      b.onclick = () => setMode(id);
      seg.append(b);
    }
    toolbar.append(seg);
    const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.01', class: 'blend', title: 'Before ↔ after' }) as HTMLInputElement;
    slider.value = String(blend);
    slider.oninput = () => {
      blend = Number(slider.value);
      applyBlend();
    };
    toolbar.append(slider);
  }
  toolbar.append(h('span', { class: 'spacer' }));
  const search = h('input', { type: 'search', placeholder: 'Find reference or value…', class: 'search' }) as HTMLInputElement;
  const results = h('div', { class: 'search-results hidden' });
  search.oninput = () => runSearch(search.value, results);
  search.onkeydown = (e) => {
    if (e.key === 'Enter') (results.firstElementChild as HTMLElement | null)?.click();
    if (e.key === 'Escape') {
      search.value = '';
      results.classList.add('hidden');
    }
  };
  toolbar.append(h('div', { class: 'search-box' }, search, results));
  const btn = (label: string, title: string, fn: () => void, cls = '') => {
    const b = h('button', { title, class: cls }, label);
    b.onclick = fn;
    toolbar.append(b);
    return b;
  };
  btn('−', 'Zoom out (-)', () => panes[0]?.pz.zoomBy(1 / 1.4));
  btn('+', 'Zoom in (+)', () => panes[0]?.pz.zoomBy(1.4));
  btn('Fit', 'Fit to page (F)', fit);
  if (isPcb) btn('Flip', 'View from bottom (B)', () => setFlipped(!ctx.flipped, true), 'flip');
  if (isDiff) {
    const boxes = btn('', '', () => {
      save({ boxes: persisted.boxes === 'selected' ? 'all' : 'selected' });
      updateBoxesButton(boxes);
      rebuildStages();
    });
    updateBoxesButton(boxes);
    btn('Changes', 'Toggle changes panel', () => togglePanel(), 'toggle-changes');
  }
  btn('{ }', 'Open as text', () => post({ type: 'command', command: 'openAsText' }));

  const body = h('div', { class: 'body' });
  const left = h('aside', { class: 'left' });
  const canvas = h('main', { class: 'canvas' });
  body.append(left, canvas);
  if (isDiff) body.append(h('aside', { class: 'right' }));

  const statusbar = h('div', { class: 'statusbar' }, h('span', { class: 'zoom' }), h('span', { class: 'cursor' }), h('span', { class: 'warnings' }));
  const children: HTMLElement[] = [toolbar];
  if (m.pairedWith) {
    const n = changes().length;
    const text = !isDiff
      ? 'Comparing… '
      : n
        ? `${n} change${n === 1 ? '' : 's'} — ${m.pairedWith === 'left' ? 'removed parts in red' : 'added parts in green'}, changed areas boxed. Pan/zoom synced. `
        : 'No semantic changes found. Pan/zoom synced. ';
    const banner = h('div', { class: 'banner' }, text);
    if (isDiff && n) {
      const list = h('button', {}, 'Change list');
      list.onclick = () => togglePanel();
      banner.append(list, ' ');
    }
    const open = h('button', {}, 'Open full KiCad diff');
    open.onclick = () => post({ type: 'command', command: 'openFullDiff' });
    banner.append(open);
    children.push(banner);
  }
  children.push(body, statusbar);
  document.body.replaceChildren(...children);
  // Half-width panes are narrow: the change list starts collapsed there.
  const panelKey = paired() ? 'showChangesPaired' : 'showChanges';
  if (paired() ? !persisted[panelKey] : persisted[panelKey] === false) document.body.classList.add('no-changes');

  const warnings = [...(m.before?.warnings ?? []), ...m.after.warnings];
  if (warnings.length) {
    const w = $('.warnings');
    w.textContent = `⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`;
    w.title = warnings.join('\n');
    w.onclick = () => post({ type: 'command', command: 'showLog' });
  }
  document.onkeydown = onKey;
}

function updateBoxesButton(b: HTMLButtonElement): void {
  const all = persisted.boxes !== 'selected';
  b.textContent = all ? 'Boxes: all' : 'Boxes: selected';
  b.title =
    'Dashed boxes mark changed areas (they are markers, not part of the drawing):\n' +
    'amber = modified, green = added, red = removed; solid = selected change.\n' +
    (all ? 'Click to show only the selected change.' : 'Click to show every change.');
}

function setMode(m: DiffMode): void {
  mode = m;
  save({ mode: m });
  rebuild();
}

function togglePanel(): void {
  document.body.classList.toggle('no-changes');
  save({ [paired() ? 'showChangesPaired' : 'showChanges']: !document.body.classList.contains('no-changes') });
  for (const p of panes) p.pz.apply(false);
}

function setFlipped(f: boolean, user: boolean): void {
  ctx.flipped = f;
  save({ flipped: f });
  document.querySelector('.flip')?.classList.toggle('active', f);
  rebuildStages();
  for (const p of panes) p.pz.setFlipped(f);
  if (user) post({ type: 'viewport', viewport: panes[0]!.pz.view, flipped: f });
}

function setSheet(id: string, user: boolean): void {
  if (id === ctx.sheetId) return;
  ctx.sheetId = id;
  save({ sheetId: id });
  renderSidebar();
  rebuildStages();
  fit();
  if (user) post({ type: 'viewport', viewport: panes[0]!.pz.view, sheet: id });
}

// ---------------------------------------------------------------------------
// Panes

function rebuild(): void {
  const canvas = $('.canvas');
  const keep = panes[0]?.pz.view ?? lastViewport;
  canvas.replaceChildren();
  canvas.className = `canvas mode-${show!.mode === 'diff' ? mode : 'view'}`;
  document.querySelectorAll<HTMLElement>('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('.blend')?.classList.toggle('hidden', mode !== 'blend' && mode !== 'swipe');
  document.querySelector('.flip')?.classList.toggle('active', ctx.flipped);

  const count = show!.mode === 'diff' && mode === 'sideBySide' ? 2 : 1;
  panes = [];
  for (let i = 0; i < count; i++) {
    const el = h('div', { class: 'pane' });
    const stage = h('div', { class: 'stage' });
    const label = h('div', { class: 'pane-label' });
    el.append(stage, label);
    canvas.append(el);
    const pz = new PanZoom(el, () => [stage]);
    pz.setFlipped(ctx.flipped);
    const pane = { el, stage, pz, label };
    pz.onChange((v, user) => {
      lastViewport = v;
      $('.zoom').textContent = `${Math.round(v.scale * 25.4)} px/in`;
      // ~200 px/in: below it anti-alias residue tints unchanged lines; above it filters get too big.
      stage.classList.toggle('aa-filter', v.scale < 8);
      if (!user || syncing) return;
      syncing = true;
      for (const o of panes) if (o !== pane) o.pz.set(v);
      syncing = false;
      save({ viewport: v });
      post({ type: 'viewport', viewport: v, sheet: ctx.sheetId, flipped: ctx.flipped });
    });
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const p = pz.toPage(e.clientX - r.left, e.clientY - r.top);
      $('.cursor').textContent = `X ${p.x.toFixed(2)}  Y ${p.y.toFixed(2)} mm`;
    });
    panes.push(pane);
  }
  renderSidebar();
  renderChanges();
  rebuildStages();
  if (keep) for (const p of panes) p.pz.set(keep);
}

function rebuildStages(): void {
  const m = show!;
  const diff = m.mode === 'diff';
  const size = pageSize(m.after.kind === 'sch' && !sheetOf(m.after, ctx.sheetId) ? m.before : m.after, ctx);
  const half = paired() ? (m.pairedWith === 'left' ? 'before' : 'after') : undefined;
  // Boxes of removed items / old positions belong to `before`, added items / new positions to `after`.
  const annotate = (stage: HTMLElement, rev?: RevisionView, side?: 'before' | 'after') =>
    buildAnnotations(stage, size, ctx, {
      changes: diff ? changes() : [],
      selected,
      flash,
      links: sheetOf(rev ?? m.after, ctx.sheetId)?.links,
      onLink: (t) => setSheet(t, true),
      side,
      onlySelected: persisted.boxes === 'selected',
    });

  if (!diff) {
    buildRevision(panes[0]!.stage, m.after, ctx);
    annotate(panes[0]!.stage);
    panes[0]!.label.textContent = '';
  } else if (half) {
    const own = half === 'before' ? m.before : m.after;
    buildOverlay(panes[0]!.stage, m.before, m.after, ctx, half);
    annotate(panes[0]!.stage, own, half);
    panes[0]!.label.replaceChildren(
      half === 'before'
        ? h('span', { class: 'legend removed' }, `− removed in ${m.after.label}`)
        : h('span', { class: 'legend added' }, `+ added since ${m.before?.label ?? ''}`),
      h('span', { class: 'legend unchanged' }, 'unchanged'),
    );
  } else if (mode === 'overlay') {
    buildOverlay(panes[0]!.stage, m.before, m.after, ctx);
    annotate(panes[0]!.stage);
    panes[0]!.label.replaceChildren(
      h('span', { class: 'legend removed' }, `− ${m.before?.label ?? ''}`),
      h('span', { class: 'legend added' }, `+ ${m.after.label}`),
      h('span', { class: 'legend unchanged' }, 'unchanged'),
    );
  } else if (mode === 'sideBySide') {
    buildRevision(panes[0]!.stage, m.before, ctx);
    buildRevision(panes[1]!.stage, m.after, ctx);
    annotate(panes[0]!.stage, m.before, 'before');
    annotate(panes[1]!.stage, m.after, 'after');
    panes[0]!.label.textContent = m.before?.label ?? '';
    panes[1]!.label.textContent = m.after.label;
  } else {
    // Blend / swipe: before underneath, after on top.
    const stage = panes[0]!.stage;
    const under = h('div', { class: 'fill' });
    const over = h('div', { class: 'fill over' });
    buildRevision(under, m.before, ctx);
    buildRevision(over, m.after, ctx);
    stage.replaceChildren(under, over);
    stage.style.width = under.style.width;
    stage.style.height = under.style.height;
    annotate(stage);
    panes[0]!.label.textContent = `${m.before?.label ?? ''}  ↔  ${m.after.label}`;
    applyBlend();
  }
}

function applyBlend(): void {
  const over = document.querySelector<HTMLElement>('.stage .over');
  if (!over) return;
  if (mode === 'blend') {
    over.style.opacity = String(blend);
    over.style.clipPath = '';
  } else {
    over.style.opacity = '1';
    over.style.clipPath = `inset(0 0 0 ${blend * 100}%)`;
  }
  // Boxes follow the slider too: old positions fade out as the new revision fades in.
  const fade = mode === 'blend';
  document.querySelectorAll('.stage svg.annotations g[data-side="before"]').forEach((g) => g.setAttribute('opacity', fade ? String(1 - blend) : '1'));
  document.querySelectorAll('.stage svg.annotations g[data-side="after"]').forEach((g) => g.setAttribute('opacity', fade ? String(blend) : '1'));
}

function contentBox(): BBox {
  const m = show!;
  if (m.after.kind === 'pcb' && m.after.contentBox && Number.isFinite(m.after.contentBox.minX)) return m.after.contentBox;
  const s = pageSize(m.after, ctx);
  return { minX: 0, minY: 0, maxX: s.width, maxY: s.height };
}

function fit(): void {
  requestAnimationFrame(() => {
    for (const p of panes) p.pz.fit(contentBox());
  });
}

// ---------------------------------------------------------------------------
// Sidebar: sheets or layers

function renderSidebar(): void {
  const left = $('.left');
  const m = show!;
  left.replaceChildren();
  if (m.after.kind === 'sch') {
    left.append(h('div', { class: 'section-title' }, 'Sheets'));
    const changed = new Set(changedSheets());
    const seen = new Set<string>();
    const list = [...(m.after.sheets ?? []), ...(m.before?.sheets ?? [])]
      .filter((s) => !seen.has(s.id) && seen.add(s.id))
      .sort((a, b) => a.page.localeCompare(b.page, undefined, { numeric: true }));
    for (const s of list) {
      const depth = s.id.split('/').length - 2;
      const inAfter = !!sheetOf(m.after, s.id);
      const inBefore = !m.before || !!sheetOf(m.before, s.id);
      const row = h(
        'div',
        { class: `row${s.id === ctx.sheetId ? ' active' : ''}${!inAfter ? ' removed' : !inBefore ? ' added' : ''}`, title: `${s.id}\n${s.file}`, style: `padding-left:${8 + depth * 12}px` },
        h('span', { class: 'page' }, s.page),
        h('span', { class: 'name' }, s.name),
      );
      if (changed.has(s.id)) row.append(h('span', { class: 'dot', title: 'Has changes' }));
      row.onclick = () => setSheet(s.id, true);
      left.append(row);
    }
  } else {
    const head = h('div', { class: 'section-title' }, 'Layers ');
    const presets = h('span', { class: 'presets' });
    const preset = (label: string, f: (n: string) => boolean) => {
      const a = h('a', { href: '#' }, label);
      a.onclick = (e) => {
        e.preventDefault();
        for (const [n, st] of ctx.layers) st.visible = f(n);
        layersChanged();
      };
      presets.append(a);
    };
    preset('All', () => true);
    preset('Copper', (n) => n.endsWith('.Cu') || n === 'Edge.Cuts');
    preset('Front', (n) => n.startsWith('F.') || n === 'Edge.Cuts');
    preset('Back', (n) => n.startsWith('B.') || n === 'Edge.Cuts');
    head.append(presets);
    left.append(head);
    const changedLayers = new Set(changes().flatMap((c) => c.locations.map((l) => l.layer)));
    const info = new Map([...(m.before?.layers ?? []), ...(m.after.layers ?? [])].map((l) => [l.name, l]));
    for (const [name, st] of ctx.layers) {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = st.visible;
      cb.onchange = () => {
        st.visible = cb.checked;
        layersChanged();
      };
      const row = h('label', { class: 'row layer', title: name }, cb, h('span', { class: 'swatch', style: `background:${layerColor(name)}` }), h('span', { class: 'name' }, info.get(name)?.userName ?? name));
      if (changedLayers.has(name)) row.append(h('span', { class: 'dot', title: 'Has changes' }));
      left.append(row);
    }
  }
}

function layersChanged(): void {
  save({ layers: [...ctx.layers] });
  renderSidebar();
  rebuildStages();
}

// ---------------------------------------------------------------------------
// Changes panel

const CATEGORY_LABEL: Record<string, string> = {
  sheet: 'Sheets', component: 'Components', net: 'Nets', label: 'Labels', wiring: 'Wiring',
  board: 'Board outline', routing: 'Routing', zone: 'Zones', graphic: 'Graphics', power: 'Power symbols',
};

function visibleChanges(): Change[] {
  const all = changes();
  if (!persisted.onlyCurrent || show?.after.kind !== 'sch') return all;
  return all.filter((c) => c.locations.some((l) => l.sheet === ctx.sheetId));
}

function renderChanges(): void {
  const right = document.querySelector<HTMLElement>('.right');
  if (!right) return;
  const list = visibleChanges();
  right.replaceChildren();
  const head = h('div', { class: 'section-title' }, `Changes (${changes().length})`);
  const nav = h('span', { class: 'nav' });
  const prev = h('button', { title: 'Previous change (Shift+F7)' }, '↑');
  const next = h('button', { title: 'Next change (F7)' }, '↓');
  prev.onclick = () => navigate(-1);
  next.onclick = () => navigate(1);
  nav.append(prev, next);
  head.append(nav);
  right.append(head);
  if (show?.after.kind === 'sch') {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = !!persisted.onlyCurrent;
    cb.onchange = () => {
      save({ onlyCurrent: cb.checked });
      renderChanges();
    };
    right.append(h('label', { class: 'only-current' }, cb, ' Only this sheet'));
  }
  if (!changes().length) {
    right.append(h('div', { class: 'empty' }, 'No semantic changes. Visual differences, if any, are shown in the overlay.'));
    return;
  }
  const groups = new Map<string, Change[]>();
  for (const c of list) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
  for (const [cat, items] of groups) {
    const det = h('details', { open: '' });
    det.append(h('summary', {}, `${CATEGORY_LABEL[cat] ?? cat} `, h('span', { class: 'count' }, String(items.length))));
    for (const c of items) det.append(changeRow(c));
    right.append(det);
  }
}

function where(c: Change): string {
  const l = c.locations[0];
  if (!l) return '';
  if (l.sheet) return sheetOf(show!.after, l.sheet)?.name ?? sheetOf(show!.before, l.sheet)?.name ?? l.sheet;
  return l.layer ?? '';
}

function changeRow(c: Change): HTMLElement {
  const sym = c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~';
  const row = h(
    'div',
    { class: `change ${c.kind}${c.id === selected ? ' selected' : ''}`, 'data-id': c.id, tabindex: '0' },
    h('span', { class: 'kind' }, sym),
    h('span', { class: 'ctitle' }, c.title),
    h('span', { class: 'summary' }, c.summary),
    h('span', { class: 'where' }, where(c)),
  );
  if (c.id === selected && c.fields.length) {
    const table = h('table', { class: 'fields' });
    for (const f of c.fields)
      table.append(h('tr', {}, h('td', {}, f.field), h('td', { class: 'before' }, f.before ?? ''), h('td', { class: 'after' }, f.after ?? '')));
    row.append(table);
  }
  row.onclick = () => selectChange(c);
  return row;
}

let locationCursor = 0;

function selectChange(c: Change): void {
  locationCursor = selected === c.id ? (locationCursor + 1) % Math.max(c.locations.length, 1) : 0;
  selected = c.id;
  flash = undefined;
  const loc = c.locations[locationCursor];
  if (loc?.sheet && loc.sheet !== ctx.sheetId) {
    ctx.sheetId = loc.sheet;
    save({ sheetId: loc.sheet });
    renderSidebar();
  }
  if (loc?.layer && ctx.layers.has(loc.layer) && !ctx.layers.get(loc.layer)!.visible) {
    ctx.layers.get(loc.layer)!.visible = true;
    save({ layers: [...ctx.layers] });
    renderSidebar();
  }
  renderChanges();
  rebuildStages();
  if (loc?.bbox) zoomTo(loc.bbox);
  else fit();
  document.querySelector(`.change[data-id="${c.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function zoomTo(b: BBox): void {
  const w = b.maxX - b.minX;
  const hgt = b.maxY - b.minY;
  // Pad around the change, but never zoom closer than a ~20 mm view so context stays visible.
  const padX = Math.max(4, Math.max(w, hgt) * 0.15, (20 - w) / 2);
  const padY = Math.max(4, Math.max(w, hgt) * 0.15, (20 - hgt) / 2);
  const box = { minX: b.minX - padX, minY: b.minY - padY, maxX: b.maxX + padX, maxY: b.maxY + padY };
  for (const p of panes) p.pz.fit(box, 0);
  post({ type: 'viewport', viewport: panes[0]!.pz.view, sheet: ctx.sheetId });
}

function navigate(dir: 1 | -1): void {
  const list = visibleChanges();
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === selected);
  const next = list[(i + dir + list.length) % list.length] ?? list[0]!;
  selectChange(next);
}

// ---------------------------------------------------------------------------
// Search

function runSearch(q: string, results: HTMLElement): void {
  q = q.trim().toLowerCase();
  results.replaceChildren();
  if (!q) return void results.classList.add('hidden');
  const m = show!;
  const items: (ItemView & { rev: string })[] = [];
  const seen = new Set<string>();
  for (const [rev, label] of [[m.after, 'after'], [m.before, 'before']] as const) {
    for (const it of rev?.items ?? []) {
      const key = `${it.ref}|${it.sheet ?? it.layer}`;
      if (seen.has(key)) continue;
      if (it.ref.toLowerCase().startsWith(q) || it.value.toLowerCase().includes(q)) {
        seen.add(key);
        items.push({ ...it, rev: label });
      }
    }
  }
  items.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  for (const it of items.slice(0, 30)) {
    const r = h('div', { class: 'result' }, h('b', {}, it.ref), ` ${it.value}`, h('span', { class: 'where' }, it.sheet ? (sheetOf(m.after, it.sheet)?.name ?? it.sheet) : (it.layer ?? '')));
    r.onclick = () => {
      results.classList.add('hidden');
      if (it.sheet && it.sheet !== ctx.sheetId) {
        ctx.sheetId = it.sheet;
        renderSidebar();
      }
      flash = it.bbox;
      rebuildStages();
      zoomTo(it.bbox);
    };
    results.append(r);
  }
  if (!items.length) results.append(h('div', { class: 'result empty' }, 'No matches'));
  results.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Keyboard

function onKey(e: KeyboardEvent): void {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'F7') {
    e.preventDefault();
    navigate(e.shiftKey ? -1 : 1);
  } else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '+' || e.key === '=') panes[0]?.pz.zoomBy(1.4);
  else if (e.key === '-') panes[0]?.pz.zoomBy(1 / 1.4);
  else if ((e.key === 'b' || e.key === 'B') && show?.after.kind === 'pcb') setFlipped(!ctx.flipped, true);
  else if (e.key === 'PageDown' || e.key === 'PageUp') {
    const ids = show?.after.sheets?.map((s) => s.id) ?? [];
    const i = ids.indexOf(ctx.sheetId ?? '');
    const n = ids[i + (e.key === 'PageDown' ? 1 : -1)];
    if (n) setSheet(n, true);
  } else if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
    if (show?.mode === 'diff') setMode((['overlay', 'sideBySide', 'blend', 'swipe'] as const)[Number(e.key) - 1]!);
  }
}
