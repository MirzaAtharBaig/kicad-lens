import { type BBox, type Point, pointBox, segmentBox, union } from '../model/geom';
import type { Netlist } from '../model/netlist';
import type { Label, Schematic, SchSymbol, SheetInstance, Wire } from '../model/schematic';
import type { Change, DiffResult, FieldChange } from './types';
import { cluster, fieldDiff, fmt, matchBy, plural, recordDiff, refCompare } from './util';

const p2s = (p: Point) => `${fmt(p.x)},${fmt(p.y)}`;

function wireKey(w: Wire): string {
  const a = p2s(w.a);
  const b = p2s(w.b);
  return `${w.kind}:${a < b ? a + '|' + b : b + '|' + a}`;
}

function symbolChanges(b: SchSymbol, a: SchSymbol): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (f: FieldChange | undefined) => f && out.push(f);
  push(fieldDiff('Reference', b.reference, a.reference));
  push(fieldDiff('Library symbol', b.libId, a.libId));
  push(fieldDiff('Unit', b.unit, a.unit));
  const { Reference: _rb, ...pb } = b.properties;
  const { Reference: _ra, ...pa } = a.properties;
  out.push(...recordDiff('', pb, pa));
  push(fieldDiff('In BOM', b.inBom, a.inBom));
  push(fieldDiff('On board', b.onBoard, a.onBoard));
  push(fieldDiff('DNP', b.dnp, a.dnp));
  push(fieldDiff('Exclude from sim', b.excludeFromSim, a.excludeFromSim));
  push(fieldDiff('Position', p2s(b.at), p2s(a.at)));
  push(fieldDiff('Rotation', b.rotation, a.rotation));
  push(fieldDiff('Mirror', b.mirror ?? 'none', a.mirror ?? 'none'));
  return out;
}

function describeFields(fields: FieldChange[]): string {
  const moved = fields.every((f) => f.field === 'Position' || f.field === 'Rotation' || f.field === 'Mirror');
  if (moved) return 'Moved';
  const value = fields.find((f) => f.field === 'Value');
  if (value) return `Value ${value.before ?? '∅'} → ${value.after ?? '∅'}`;
  return `${fields.map((f) => f.field).slice(0, 3).join(', ')}${fields.length > 3 ? '…' : ''} changed`;
}

function sheetDiff(sb: SheetInstance | undefined, sa: SheetInstance | undefined, nextId: () => string): Change[] {
  const sheet = (sa ?? sb)!.namePath;
  const changes: Change[] = [];
  const symB = sb?.symbols ?? [];
  const symA = sa?.symbols ?? [];

  // --- Components -------------------------------------------------------
  const m = matchBy(symB, symA, [(s) => s.uuid || undefined, (s) => `${s.reference}#${s.unit}`]);
  for (const s of m.removed)
    changes.push({
      id: nextId(), category: 'component', kind: 'removed', title: s.reference,
      summary: `Removed ${s.properties['Value'] ?? ''} (${s.libId})`.trim(),
      fields: [{ field: 'Value', before: s.properties['Value'] }, { field: 'Library symbol', before: s.libId }],
      locations: [{ sheet, bbox: s.bbox }],
    });
  for (const s of m.added)
    changes.push({
      id: nextId(), category: 'component', kind: 'added', title: s.reference,
      summary: `Added ${s.properties['Value'] ?? ''} (${s.libId})`.trim(),
      fields: [{ field: 'Value', after: s.properties['Value'] }, { field: 'Library symbol', after: s.libId }],
      locations: [{ sheet, bbox: s.bbox }],
    });
  for (const [b, a] of m.pairs) {
    const fields = symbolChanges(b, a);
    if (!fields.length) continue;
    changes.push({
      id: nextId(), category: 'component', kind: 'modified', title: a.reference,
      summary: describeFields(fields), fields,
      locations: [{ sheet, bbox: union(b.bbox, a.bbox) }],
    });
  }

  // --- Wiring (wires, junctions, no-connects) --------------------------------
  type Item = { box: BBox; added: boolean };
  const items: Item[] = [];
  const setDiff = <T>(bs: T[], as: T[], key: (t: T) => string, box: (t: T) => BBox) => {
    const kb = new Set(bs.map(key));
    const ka = new Set(as.map(key));
    for (const t of bs) if (!ka.has(key(t))) items.push({ box: box(t), added: false });
    for (const t of as) if (!kb.has(key(t))) items.push({ box: box(t), added: true });
  };
  setDiff(sb?.wires ?? [], sa?.wires ?? [], wireKey, (w) => segmentBox(w.a, w.b, 0.2));
  setDiff(sb?.junctions ?? [], sa?.junctions ?? [], (p) => 'j' + p2s(p), (p) => pointBox(p, 0.5));
  setDiff(sb?.noConnects ?? [], sa?.noConnects ?? [], (p) => 'x' + p2s(p), (p) => pointBox(p, 0.7));
  for (const c of cluster(items, (i) => i.box, 1.27)) {
    const add = c.items.filter((i) => i.added).length;
    const rem = c.items.length - add;
    changes.push({
      id: nextId(), category: 'wiring', kind: rem === 0 ? 'added' : add === 0 ? 'removed' : 'modified',
      title: 'Wiring',
      summary: [add && `${plural(add, 'item')} added`, rem && `${plural(rem, 'item')} removed`].filter(Boolean).join(', '),
      fields: [], locations: [{ sheet, bbox: c.bbox }],
    });
  }

  // --- Labels ------------------------------------------------------------------
  const lk = (l: Label) => `${l.kind}@${p2s(l.at)}`;
  const lm = matchBy(sb?.labels ?? [], sa?.labels ?? [], [(l) => `${lk(l)}=${l.text}`, lk, (l) => `${l.kind}=${l.text}`]);
  const kindName = (l: Label) => l.kind.replace('_', ' ');
  for (const l of lm.removed)
    changes.push({ id: nextId(), category: 'label', kind: 'removed', title: l.text, summary: `Removed ${kindName(l)}`, fields: [], locations: [{ sheet, bbox: pointBox(l.at, 2) }] });
  for (const l of lm.added)
    changes.push({ id: nextId(), category: 'label', kind: 'added', title: l.text, summary: `Added ${kindName(l)}`, fields: [], locations: [{ sheet, bbox: pointBox(l.at, 2) }] });
  for (const [b, a] of lm.pairs) {
    if (b.text !== a.text)
      changes.push({
        id: nextId(), category: 'label', kind: 'modified', title: a.text, summary: `Renamed ${b.text} → ${a.text}`,
        fields: [{ field: 'Text', before: b.text, after: a.text }], locations: [{ sheet, bbox: pointBox(a.at, 2) }],
      });
    else if (p2s(b.at) !== p2s(a.at))
      changes.push({
        id: nextId(), category: 'label', kind: 'modified', title: a.text, summary: 'Moved',
        fields: [{ field: 'Position', before: p2s(b.at), after: p2s(a.at) }],
        locations: [{ sheet, bbox: union(pointBox(b.at, 2), pointBox(a.at, 2)) }],
      });
  }

  // --- Sub-sheet frames -----------------------------------------------------------
  const fm = matchBy(sb?.sheetFrames ?? [], sa?.sheetFrames ?? [], [(f) => f.uuid, (f) => f.name]);
  for (const f of fm.removed)
    changes.push({ id: nextId(), category: 'sheet', kind: 'removed', title: f.name, summary: `Removed sheet ${f.file}`, fields: [], locations: [{ sheet, bbox: f.bbox }] });
  for (const f of fm.added)
    changes.push({ id: nextId(), category: 'sheet', kind: 'added', title: f.name, summary: `Added sheet ${f.file}`, fields: [], locations: [{ sheet, bbox: f.bbox }] });
  for (const [b, a] of fm.pairs) {
    const fields = [fieldDiff('Name', b.name, a.name), fieldDiff('File', b.file, a.file)].filter((x): x is FieldChange => !!x);
    if (fields.length)
      changes.push({ id: nextId(), category: 'sheet', kind: 'modified', title: a.name, summary: describeFields(fields), fields, locations: [{ sheet, bbox: a.bbox }] });
  }
  return changes;
}

function netChanges(nb: Netlist, na: Netlist, sch: Schematic, nextId: () => string): Change[] {
  // Where to show a pin: every placement of its reference designator.
  const where = new Map<string, { sheet: string; bbox: BBox }[]>();
  for (const s of sch.sheets)
    for (const sym of s.symbols) {
      const list = where.get(sym.reference) ?? [];
      list.push({ sheet: s.namePath, bbox: sym.bbox });
      where.set(sym.reference, list);
    }
  const locate = (pins: string[]) => {
    const refs = [...new Set(pins.map((p) => p.slice(0, p.lastIndexOf('.'))))];
    return refs.flatMap((r) => where.get(r) ?? []).slice(0, 20);
  };

  const changes: Change[] = [];
  const removed = [...nb.nets.keys()].filter((n) => !na.nets.has(n));
  const added = new Set([...na.nets.keys()].filter((n) => !nb.nets.has(n)));
  const sig = (pins: string[]) => pins.join(',');
  const addedBySig = new Map<string, string>();
  for (const n of added) addedBySig.set(sig(na.nets.get(n)!), n);

  for (const n of removed) {
    const pins = nb.nets.get(n)!;
    const renamed = addedBySig.get(sig(pins));
    if (renamed !== undefined && pins.length) {
      added.delete(renamed);
      changes.push({
        id: nextId(), category: 'net', kind: 'modified', title: renamed, summary: `Net renamed ${n} → ${renamed}`,
        fields: [{ field: 'Name', before: n, after: renamed }], locations: locate(pins),
      });
    } else {
      changes.push({
        id: nextId(), category: 'net', kind: 'removed', title: n, summary: `Net removed (${plural(pins.length, 'pin')})`,
        fields: [{ field: 'Pins', before: pins.join(' ') }], locations: locate(pins),
      });
    }
  }
  for (const n of added) {
    const pins = na.nets.get(n)!;
    changes.push({
      id: nextId(), category: 'net', kind: 'added', title: n, summary: `Net added (${plural(pins.length, 'pin')})`,
      fields: [{ field: 'Pins', after: pins.join(' ') }], locations: locate(pins),
    });
  }
  for (const [n, pb] of nb.nets) {
    const pa = na.nets.get(n);
    if (!pa || sig(pa) === sig(pb)) continue;
    const sb = new Set(pb);
    const sa = new Set(pa);
    const lost = pb.filter((p) => !sa.has(p));
    const gained = pa.filter((p) => !sb.has(p));
    const parts = [gained.length && `+${gained.join(' +')}`, lost.length && `−${lost.join(' −')}`].filter(Boolean);
    changes.push({
      id: nextId(), category: 'net', kind: 'modified', title: n, summary: parts.join('  ').slice(0, 160),
      fields: [
        ...(gained.length ? [{ field: 'Pins added', after: gained.join(' ') }] : []),
        ...(lost.length ? [{ field: 'Pins removed', before: lost.join(' ') }] : []),
      ],
      locations: locate([...gained, ...lost]),
    });
  }
  return changes;
}

export interface SchematicDiffInput {
  before: Schematic;
  after: Schematic;
  netlistBefore?: Netlist;
  netlistAfter?: Netlist;
}

export function diffSchematic({ before, after, netlistBefore, netlistAfter }: SchematicDiffInput): DiffResult {
  let n = 0;
  const nextId = () => `c${++n}`;
  const changes: Change[] = [];

  const sm = matchBy(before.sheets, after.sheets, [(s) => s.path, (s) => s.namePath]);
  for (const s of sm.removed)
    changes.push({ id: nextId(), category: 'sheet', kind: 'removed', title: s.namePath, summary: `Sheet instance removed (${s.file})`, fields: [], locations: [{ sheet: s.namePath }] });
  for (const s of sm.added)
    changes.push({ id: nextId(), category: 'sheet', kind: 'added', title: s.namePath, summary: `Sheet instance added (${s.file})`, fields: [], locations: [{ sheet: s.namePath }] });
  for (const [b, a] of sm.pairs) changes.push(...sheetDiff(b, a, nextId));
  for (const s of sm.added) changes.push(...sheetDiff(undefined, s, nextId));
  for (const s of sm.removed) changes.push(...sheetDiff(s, undefined, nextId));

  if (netlistBefore && netlistAfter) changes.push(...netChanges(netlistBefore, netlistAfter, after, nextId));

  const order = new Map(after.sheets.map((s, i) => [s.namePath, i]));
  const catOrder = ['sheet', 'component', 'net', 'label', 'wiring'];
  changes.sort(
    (x, y) =>
      catOrder.indexOf(x.category) - catOrder.indexOf(y.category) ||
      (order.get(x.locations[0]?.sheet ?? '') ?? 99) - (order.get(y.locations[0]?.sheet ?? '') ?? 99) ||
      refCompare(x.title, y.title),
  );
  return {
    changes,
    changedSheets: [...new Set(changes.flatMap((c) => c.locations.map((l) => l.sheet!).filter(Boolean)))],
    changedLayers: [],
  };
}
