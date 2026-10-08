import { Sym, type SList, at, child, childStr, children, flag, num, parseSExpr, str, tag, xy } from '../sexpr';
import { type BBox, type Point, addPoint, emptyBox, inflate, isEmpty, pointBox, rotate } from './geom';

export interface SchSymbol {
  /** Stable identity across revisions: sheet instance path + symbol uuid. */
  key: string;
  uuid: string;
  reference: string;
  libId: string;
  unit: number;
  at: Point;
  rotation: number;
  mirror?: 'x' | 'y';
  properties: Record<string, string>;
  inBom: boolean;
  onBoard: boolean;
  dnp: boolean;
  excludeFromSim: boolean;
  bbox: BBox;
}

export interface Wire {
  kind: 'wire' | 'bus';
  a: Point;
  b: Point;
}

export interface Label {
  kind: 'label' | 'global_label' | 'hierarchical_label';
  text: string;
  at: Point;
}

export interface SheetFrame {
  uuid: string;
  name: string;
  file: string;
  bbox: BBox;
}

export interface SheetInstance {
  /** UUID path, e.g. `/root-uuid/sheet-uuid`. */
  path: string;
  /** Human path as KiCad prints it, e.g. `/USBtoEthernet/LAN9500AI/`. */
  namePath: string;
  /** Sheet file, relative to the directory of the root sheet. */
  file: string;
  page: string;
  symbols: SchSymbol[];
  wires: Wire[];
  labels: Label[];
  junctions: Point[];
  noConnects: Point[];
  sheetFrames: SheetFrame[];
  paper: { width: number; height: number };
}

export interface Schematic {
  rootFile: string;
  projectName: string;
  sheets: SheetInstance[];
  /** Files that make up the hierarchy, root first. */
  files: string[];
}

/** Reads a file relative to the root sheet's directory; undefined if missing. */
export type FileReader = (relPath: string) => Promise<string | undefined>;

const PAPER: Record<string, [number, number]> = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
};

export function paperSize(root: SList): { width: number; height: number } {
  const p = child(root, 'paper');
  const name = str(p) ?? 'A4';
  let [w, h] = PAPER[name] ?? [297, 210];
  if (name === 'User') {
    w = num(p, 2) ?? w;
    h = num(p, 3) ?? h;
  }
  if (p?.some((e) => e instanceof Sym && e.name === 'portrait')) [w, h] = [h, w];
  return { width: w, height: h };
}

function sheetProps(s: SList): { name: string; file: string } {
  let name = '';
  let file = '';
  for (const p of children(s, 'property')) {
    const k = str(p, 1);
    if (k === 'Sheetname' || k === 'Sheet name') name = str(p, 2) ?? '';
    if (k === 'Sheetfile' || k === 'Sheet file') file = str(p, 2) ?? '';
  }
  return { name, file };
}

/** Collect the drawable points of a library symbol for one unit (unit 0 = shared). */
function libSymbolPoints(lib: SList, unit: number, bodyStyle: number): Point[] {
  const pts: Point[] = [];
  const visit = (l: SList) => {
    for (const e of l) {
      if (!Array.isArray(e)) continue;
      const t = tag(e);
      if (t === 'symbol') {
        // Sub-units are named <name>_<unit>_<bodyStyle>.
        const m = /_(\d+)_(\d+)$/.exec(str(e, 1) ?? '');
        if (m) {
          const u = Number(m[1]);
          const st = Number(m[2]);
          if ((u === 0 || u === unit) && (st === 0 || st === bodyStyle)) visit(e);
        }
      } else if (t === 'pin') {
        const a = at(e);
        const len = num(child(e, 'length')) ?? 0;
        if (a) {
          const r = (a.rot * Math.PI) / 180;
          pts.push({ x: a.x, y: a.y }, { x: a.x + len * Math.cos(r), y: a.y + len * Math.sin(r) });
        }
      } else if (t === 'circle') {
        const c = child(e, 'center');
        const r = num(child(e, 'radius')) ?? 0;
        if (c) {
          const p = xy(c);
          pts.push({ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r });
        }
      } else if (t === 'rectangle' || t === 'arc' || t === 'polyline' || t === 'bezier') {
        for (const f of e) {
          if (!Array.isArray(f)) continue;
          const ft = tag(f);
          if (ft === 'start' || ft === 'end' || ft === 'mid') pts.push(xy(f));
          else if (ft === 'pts') for (const q of children(f, 'xy')) pts.push(xy(q));
        }
      }
    }
  };
  visit(lib);
  return pts;
}

function symbolBBox(libPts: Point[], pos: Point, rot: number, mirror?: 'x' | 'y'): BBox {
  const b = emptyBox();
  for (const p0 of libPts) {
    // Library symbols are Y-up: flip into schematic space, then mirror, then rotate.
    let p = { x: p0.x, y: -p0.y };
    if (mirror === 'x') p = { x: p.x, y: -p.y };
    if (mirror === 'y') p = { x: -p.x, y: p.y };
    p = rotate(p, rot);
    addPoint(b, { x: pos.x + p.x, y: pos.y + p.y });
  }
  return isEmpty(b) ? pointBox(pos, 2.54) : inflate(b, 0.635);
}

/** Reference/unit of a symbol for one sheet instance (KiCad 7+ `instances` block). */
function instanceData(sym: SList, path: string, project: string): { ref?: string; unit?: number } {
  const inst = child(sym, 'instances');
  if (!inst) return {};
  let fallback: { ref?: string; unit?: number } = {};
  for (const proj of children(inst, 'project')) {
    for (const p of children(proj, 'path')) {
      if (str(p) !== path) continue;
      const r = { ref: childStr(p, 'reference'), unit: num(child(p, 'unit')) };
      if (str(proj) === project) return r;
      fallback = r;
    }
  }
  return fallback;
}

/** Page number of a child sheet placed under `parentPath` (KiCad 7+). */
function sheetPage(sheet: SList, parentPath: string): string | undefined {
  const inst = child(sheet, 'instances');
  if (!inst) return undefined;
  for (const proj of children(inst, 'project'))
    for (const p of children(proj, 'path')) if (str(p) === parentPath) return childStr(p, 'page');
  return undefined;
}

interface ChildRef {
  uuid: string;
  name: string;
  file: string;
  page?: string;
}

export function parseSheet(
  text: string,
  path: string,
  namePath: string,
  file: string,
  projectName: string,
): { sheet: SheetInstance; childSheets: ChildRef[] } {
  const root = parseSExpr(text);
  if (tag(root) !== 'kicad_sch') throw new Error(`${file}: not a KiCad schematic`);

  const libs = new Map<string, SList>();
  const libSyms = child(root, 'lib_symbols');
  if (libSyms) for (const s of children(libSyms, 'symbol')) libs.set(str(s) ?? '', s);

  const sheet: SheetInstance = {
    path,
    namePath,
    file,
    page: '',
    symbols: [],
    wires: [],
    labels: [],
    junctions: [],
    noConnects: [],
    sheetFrames: [],
    paper: paperSize(root),
  };
  const childSheets: ChildRef[] = [];

  for (const e of root) {
    if (!Array.isArray(e)) continue;
    switch (tag(e)) {
      case 'symbol': {
        const uuid = childStr(e, 'uuid') ?? '';
        const libId = childStr(e, 'lib_id') ?? '';
        const a = at(e) ?? { x: 0, y: 0, rot: 0 };
        const m = childStr(e, 'mirror');
        const mirror = m === 'x' || m === 'y' ? m : undefined;
        const properties: Record<string, string> = {};
        for (const p of children(e, 'property')) properties[str(p, 1) ?? ''] = str(p, 2) ?? '';
        const inst = instanceData(e, path, projectName);
        const unit = inst.unit ?? num(child(e, 'unit')) ?? 1;
        const lib = libs.get(childStr(e, 'lib_name') ?? libId);
        const pts = lib ? libSymbolPoints(lib, unit, num(child(e, 'body_style')) ?? num(child(e, 'convert')) ?? 1) : [];
        const reference = inst.ref ?? properties['Reference'] ?? '?';
        properties['Reference'] = reference;
        sheet.symbols.push({
          key: `${path}/${uuid}`,
          uuid,
          reference,
          libId,
          unit,
          at: { x: a.x, y: a.y },
          rotation: a.rot,
          mirror,
          properties,
          inBom: child(e, 'in_bom') ? flag(e, 'in_bom') : true,
          onBoard: child(e, 'on_board') ? flag(e, 'on_board') : true,
          dnp: child(e, 'dnp') ? flag(e, 'dnp') : false,
          excludeFromSim: child(e, 'exclude_from_sim') ? flag(e, 'exclude_from_sim') : false,
          bbox: symbolBBox(pts, a, a.rot, mirror),
        });
        break;
      }
      case 'wire':
      case 'bus': {
        const pts = children(child(e, 'pts') ?? [], 'xy').map(xy);
        for (let i = 1; i < pts.length; i++) sheet.wires.push({ kind: tag(e) as Wire['kind'], a: pts[i - 1]!, b: pts[i]! });
        break;
      }
      case 'label':
      case 'global_label':
      case 'hierarchical_label': {
        const a = at(e);
        if (a) sheet.labels.push({ kind: tag(e) as Label['kind'], text: str(e) ?? '', at: { x: a.x, y: a.y } });
        break;
      }
      case 'junction': {
        const a = at(e);
        if (a) sheet.junctions.push({ x: a.x, y: a.y });
        break;
      }
      case 'no_connect': {
        const a = at(e);
        if (a) sheet.noConnects.push({ x: a.x, y: a.y });
        break;
      }
      case 'sheet': {
        const uuid = childStr(e, 'uuid') ?? '';
        const { name, file: f } = sheetProps(e);
        const a = at(e) ?? { x: 0, y: 0, rot: 0 };
        const size = child(e, 'size');
        const bbox = { minX: a.x, minY: a.y, maxX: a.x + (num(size, 1) ?? 0), maxY: a.y + (num(size, 2) ?? 0) };
        sheet.sheetFrames.push({ uuid, name, file: f, bbox });
        childSheets.push({ uuid, name, file: f, page: sheetPage(e, path) });
        break;
      }
    }
  }
  return { sheet, childSheets };
}

function rootUuid(root: SList): string {
  return childStr(root, 'uuid') ?? '';
}

function legacyPages(root: SList): Map<string, string> {
  const pages = new Map<string, string>();
  const si = child(root, 'sheet_instances');
  if (si) for (const p of children(si, 'path')) pages.set(str(p) ?? '', childStr(p, 'page') ?? '');
  return pages;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

/**
 * Load a full schematic hierarchy starting from the root sheet.
 * A sub-sheet placed several times yields one SheetInstance per placement.
 */
export async function loadSchematic(rootFile: string, read: FileReader): Promise<Schematic> {
  const rootText = await read(rootFile);
  if (rootText === undefined) throw new Error(`Cannot read ${rootFile}`);
  const projectName = rootFile.replace(/^.*\//, '').replace(/\.kicad_sch$/, '');
  const dir = dirOf(rootFile);
  const rootTree = parseSExpr(rootText);
  const pages = legacyPages(rootTree);
  const texts = new Map<string, string>([[rootFile, rootText]]);
  const sheets: SheetInstance[] = [];

  const walk = async (file: string, text: string, path: string, namePath: string, page: string, depth: number) => {
    if (depth > 32) throw new Error('Schematic hierarchy too deep (recursive sheets?)');
    const { sheet, childSheets } = parseSheet(text, path, namePath, file, projectName);
    sheet.page = page;
    sheets.push(sheet);
    for (const c of childSheets) {
      const childFile = dir + c.file.replace(/\\/g, '/');
      let t = texts.get(childFile);
      if (t === undefined) {
        t = await read(childFile);
        if (t === undefined) continue; // missing sub-sheet: show what we can
        texts.set(childFile, t);
      }
      const childPath = `${path}/${c.uuid}`;
      const childPage = c.page ?? pages.get(childPath) ?? '';
      await walk(childFile, t, childPath, `${namePath}${c.name}/`, childPage, depth + 1);
    }
  };
  await walk(rootFile, rootText, `/${rootUuid(rootTree)}`, '/', pages.get('/') ?? '1', 0);

  sheets.forEach((s, i) => {
    if (!s.page) s.page = String(i + 1);
  });
  return { rootFile, projectName, sheets, files: [...texts.keys()].map((f) => f.slice(dir.length)) };
}

/** File name kicad-cli gives the SVG of a sheet instance. */
export function sheetSvgName(projectName: string, namePath: string): string {
  const trimmed = namePath.replace(/^\/+|\/+$/g, '');
  return trimmed ? `${projectName}-${trimmed.replace(/\//g, '-')}.svg` : `${projectName}.svg`;
}
