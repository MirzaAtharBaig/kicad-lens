import { Sym, type SList, at, child, childStr, children, num, parseSExpr, str, tag, xy } from '../sexpr';
import { type BBox, type Point, addPoint, dist, emptyBox, isEmpty, pointBox, rotate, segmentBox } from './geom';
import { paperSize } from './schematic';

export interface PcbLayer {
  ordinal: number;
  /** Canonical name used in files and on the kicad-cli command line, e.g. `F.SilkS`. */
  name: string;
  type: string;
  /** User-visible name, e.g. `F.Silkscreen`; kicad-cli names its SVGs after this. */
  userName: string;
}

export interface Pad {
  number: string;
  net: string;
  at: Point;
}

export interface Footprint {
  /** Stable identity: footprint uuid (falls back to reference). */
  key: string;
  uuid: string;
  reference: string;
  value: string;
  fpid: string;
  side: 'front' | 'back';
  at: Point;
  rotation: number;
  properties: Record<string, string>;
  attrs: string[];
  pads: Pad[];
  bbox: BBox;
}

export interface Track {
  kind: 'segment' | 'arc';
  uuid: string;
  a: Point;
  b: Point;
  width: number;
  layer: string;
  net: string;
  length: number;
}

export interface Via {
  uuid: string;
  at: Point;
  size: number;
  drill: number;
  layers: string[];
  net: string;
}

export interface Zone {
  uuid: string;
  name: string;
  net: string;
  layers: string[];
  outline: Point[];
  priority: number;
  bbox: BBox;
}

export interface Graphic {
  kind: string;
  uuid: string;
  layer: string;
  points: Point[];
  bbox: BBox;
}

export interface Pcb {
  layers: PcbLayer[];
  /** Layers that actually carry objects. */
  usedLayers: string[];
  nets: string[];
  footprints: Footprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  graphics: Graphic[];
  paper: { width: number; height: number };
  boardBox: BBox;
}

/** Turn a footprint-local point into board coordinates. */
function place(p: Point, origin: Point, rot: number): Point {
  const r = rotate(p, rot);
  return { x: origin.x + r.x, y: origin.y + r.y };
}

function layerList(e: SList): string[] {
  const l = child(e, 'layers') ?? child(e, 'layer');
  if (!l) return [];
  return l.slice(1).map((v) => (v instanceof Sym ? v.name : String(v)));
}

function graphicPoints(e: SList): Point[] {
  const pts: Point[] = [];
  for (const f of e) {
    if (!Array.isArray(f)) continue;
    const t = tag(f);
    if (t === 'start' || t === 'end' || t === 'mid' || t === 'center') pts.push(xy(f));
    else if (t === 'pts') for (const q of children(f, 'xy')) pts.push(xy(q));
  }
  // Circles store centre + a point on the circumference.
  if (tag(e)?.endsWith('_circle')) {
    const c = child(e, 'center');
    const p = child(e, 'end');
    if (c && p) {
      const cc = xy(c);
      const r = dist(cc, xy(p));
      return [{ x: cc.x - r, y: cc.y - r }, { x: cc.x + r, y: cc.y + r }];
    }
  }
  return pts;
}

export function parsePcb(text: string): Pcb {
  const root = parseSExpr(text);
  if (tag(root) !== 'kicad_pcb') throw new Error('Not a KiCad PCB file');

  const layers: PcbLayer[] = [];
  const layersNode = child(root, 'layers');
  if (layersNode)
    for (const l of layersNode) {
      if (!Array.isArray(l)) continue;
      const name = str(l, 1) ?? '';
      layers.push({ ordinal: num(l, 0) ?? 0, name, type: str(l, 2) ?? '', userName: str(l, 3) ?? name });
    }

  // KiCad <= 9 references nets by number; newer files may use names directly.
  const netNames = new Map<number, string>();
  for (const n of children(root, 'net')) netNames.set(num(n, 1) ?? 0, str(n, 2) ?? '');
  const netOf = (e: SList): string => {
    const n = child(e, 'net');
    if (!n) return '';
    const v = n[1];
    if (typeof v === 'number') return str(n, 2) ?? netNames.get(v) ?? '';
    return str(n) ?? '';
  };

  const used = new Set<string>();
  const footprints: Footprint[] = [];
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const zones: Zone[] = [];
  const graphics: Graphic[] = [];
  const boardBox = emptyBox();

  for (const e of root) {
    if (!Array.isArray(e)) continue;
    const t = tag(e);
    switch (t) {
      case 'footprint':
      case 'module': {
        const uuid = childStr(e, 'uuid') ?? childStr(e, 'tstamp') ?? '';
        const a = at(e) ?? { x: 0, y: 0, rot: 0 };
        const origin = { x: a.x, y: a.y };
        const layer = childStr(e, 'layer') ?? 'F.Cu';
        const properties: Record<string, string> = {};
        for (const p of children(e, 'property')) properties[str(p, 1) ?? ''] = str(p, 2) ?? '';
        for (const ft of children(e, 'fp_text')) {
          const kind = str(ft, 1);
          if (kind === 'reference') properties['Reference'] ??= str(ft, 2) ?? '';
          if (kind === 'value') properties['Value'] ??= str(ft, 2) ?? '';
        }
        const attrNode = child(e, 'attr');
        const attrs = attrNode ? attrNode.slice(1).map(String) : [];
        const bbox = emptyBox();
        const pads: Pad[] = [];
        for (const f of e) {
          if (!Array.isArray(f)) continue;
          const ft = tag(f);
          if (ft === 'pad') {
            const pa = at(f) ?? { x: 0, y: 0, rot: 0 };
            const size = child(f, 'size');
            const r = Math.max(num(size, 1) ?? 0, num(size, 2) ?? 0) / 2;
            const p = place(pa, origin, a.rot);
            addPoint(addPoint(bbox, { x: p.x - r, y: p.y - r }), { x: p.x + r, y: p.y + r });
            pads.push({ number: str(f) ?? '', net: netOf(f), at: p });
            for (const l of layerList(f)) if (!l.includes('*')) used.add(l);
          } else if (ft?.startsWith('fp_') && ft !== 'fp_text') {
            for (const p of graphicPoints(f)) addPoint(bbox, place(p, origin, a.rot));
            const l = childStr(f, 'layer');
            if (l) used.add(l);
          } else if (ft === 'property' || ft === 'fp_text') {
            const l = childStr(f, 'layer');
            if (l && !child(f, 'hide') && !(f as SList).some((x) => x instanceof Sym && x.name === 'hide')) used.add(l);
          }
        }
        if (layer.startsWith('B.')) used.add('B.Cu');
        footprints.push({
          key: uuid || properties['Reference'] || '',
          uuid,
          reference: properties['Reference'] ?? '',
          value: properties['Value'] ?? '',
          fpid: str(e) ?? '',
          side: layer.startsWith('B.') ? 'back' : 'front',
          at: origin,
          rotation: a.rot,
          properties,
          attrs,
          pads,
          bbox: isEmpty(bbox) ? pointBox(origin, 1) : bbox,
        });
        break;
      }
      case 'segment':
      case 'arc': {
        const s = xy(child(e, 'start') ?? []);
        const en = xy(child(e, 'end') ?? []);
        const layer = childStr(e, 'layer') ?? '';
        used.add(layer);
        let length = dist(s, en);
        const mid = child(e, 'mid');
        if (t === 'arc' && mid) {
          // Arc length from the circle through start/mid/end.
          const m = xy(mid);
          const chord = dist(s, en);
          const sag = dist(m, { x: (s.x + en.x) / 2, y: (s.y + en.y) / 2 });
          if (sag > 1e-9) {
            const r = (chord * chord) / (8 * sag) + sag / 2;
            length = 2 * r * Math.asin(Math.min(1, chord / (2 * r)));
            if (sag > r) length = 2 * Math.PI * r - length;
          }
        }
        tracks.push({
          kind: t,
          uuid: childStr(e, 'uuid') ?? '',
          a: s,
          b: en,
          width: num(child(e, 'width')) ?? 0,
          layer,
          net: netOf(e),
          length,
        });
        break;
      }
      case 'via': {
        const a = at(e) ?? { x: 0, y: 0, rot: 0 };
        const ls = layerList(e);
        ls.forEach((l) => used.add(l));
        vias.push({
          uuid: childStr(e, 'uuid') ?? '',
          at: { x: a.x, y: a.y },
          size: num(child(e, 'size')) ?? 0,
          drill: num(child(e, 'drill')) ?? 0,
          layers: ls,
          net: netOf(e),
        });
        break;
      }
      case 'zone': {
        const outline = children(child(child(e, 'polygon') ?? [], 'pts') ?? [], 'xy').map(xy);
        const bbox = emptyBox();
        outline.forEach((p) => addPoint(bbox, p));
        const ls = layerList(e);
        ls.forEach((l) => !l.includes('*') && used.add(l));
        zones.push({
          uuid: childStr(e, 'uuid') ?? '',
          name: childStr(e, 'name') ?? '',
          net: childStr(e, 'net_name') ?? netOf(e),
          layers: ls,
          outline,
          priority: num(child(e, 'priority')) ?? 0,
          bbox,
        });
        break;
      }
      default: {
        if (!t?.startsWith('gr_') || t === 'gr_text' || t === 'gr_text_box') {
          if (t === 'gr_text' || t === 'gr_text_box') {
            const l = childStr(e, 'layer');
            const a = at(e);
            if (l && a) {
              used.add(l);
              graphics.push({ kind: t, uuid: childStr(e, 'uuid') ?? '', layer: l, points: [a], bbox: pointBox(a, 1) });
            }
          }
          break;
        }
        const layer = childStr(e, 'layer') ?? '';
        const points = graphicPoints(e);
        const bbox = emptyBox();
        points.forEach((p) => addPoint(bbox, p));
        used.add(layer);
        graphics.push({ kind: t, uuid: childStr(e, 'uuid') ?? '', layer, points, bbox });
        if (layer === 'Edge.Cuts') points.forEach((p) => addPoint(boardBox, p));
      }
    }
  }

  if (isEmpty(boardBox)) {
    for (const f of footprints) {
      addPoint(boardBox, { x: f.bbox.minX, y: f.bbox.minY });
      addPoint(boardBox, { x: f.bbox.maxX, y: f.bbox.maxY });
    }
  }

  const order = new Map(layers.map((l, i) => [l.name, i]));
  return {
    layers,
    usedLayers: [...used].filter((l) => order.has(l)).sort((a, b) => order.get(a)! - order.get(b)!),
    nets: [...new Set(netNames.values())].filter(Boolean),
    footprints,
    tracks,
    vias,
    zones,
    graphics,
    paper: paperSize(root),
    boardBox,
  };
}

export function trackBox(t: Track): BBox {
  return segmentBox(t.a, t.b, t.width / 2);
}

export function viaBox(v: Via): BBox {
  return pointBox(v.at, v.size / 2);
}

/** File name kicad-cli gives a layer's SVG in `--mode-multi`. */
export function layerSvgName(boardName: string, layer: PcbLayer): string {
  return `${boardName}-${layer.userName.replace(/\./g, '_')}.svg`;
}
