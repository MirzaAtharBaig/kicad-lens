/** Small synthetic KiCad documents for diff tests. */

const RESISTOR_LIB = `
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))`;

export interface SymSpec {
  uuid: string;
  ref: string;
  value: string;
  x: number;
  y: number;
  rot?: number;
  dnp?: boolean;
}

export function schematic(opts: {
  symbols: SymSpec[];
  wires?: [number, number, number, number][];
  labels?: { text: string; x: number; y: number }[];
  sheets?: { uuid: string; name: string; file: string }[];
}): string {
  const syms = opts.symbols
    .map(
      (s) => `
  (symbol (lib_id "Device:R") (at ${s.x} ${s.y} ${s.rot ?? 0}) (unit 1)
    (in_bom yes) (on_board yes) (dnp ${s.dnp ? 'yes' : 'no'})
    (uuid "${s.uuid}")
    (property "Reference" "${s.ref}" (at 0 0 0))
    (property "Value" "${s.value}" (at 0 0 0))
    (property "Footprint" "Resistor_SMD:R_0603" (at 0 0 0))
    (instances (project "demo" (path "/root-uuid" (reference "${s.ref}") (unit 1)))))`,
    )
    .join('');
  const wires = (opts.wires ?? [])
    .map(([x1, y1, x2, y2]) => `\n  (wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (uuid "w-${x1}-${y1}-${x2}-${y2}"))`)
    .join('');
  const labels = (opts.labels ?? []).map((l) => `\n  (label "${l.text}" (at ${l.x} ${l.y} 0))`).join('');
  const sheets = (opts.sheets ?? [])
    .map(
      (s) => `
  (sheet (at 100 100) (size 20 10) (uuid "${s.uuid}")
    (property "Sheetname" "${s.name}" (at 0 0 0))
    (property "Sheetfile" "${s.file}" (at 0 0 0))
    (instances (project "demo" (path "/root-uuid" (page "2")))))`,
    )
    .join('');
  return `(kicad_sch (version 20250114) (generator "eeschema") (uuid "root-uuid") (paper "A4")
${RESISTOR_LIB}${syms}${wires}${labels}${sheets}
  (sheet_instances (path "/" (page "1"))))`;
}

export function subSheet(symbols: SymSpec[], parentPath = '/root-uuid/sub-uuid'): string {
  return schematic({ symbols }).replace(/\(path "\/root-uuid"/g, `(path "${parentPath}"`).replace('(uuid "root-uuid")', '(uuid "sub-file-uuid")');
}

export interface FpSpec {
  uuid: string;
  ref: string;
  value: string;
  x: number;
  y: number;
  rot?: number;
  side?: 'F' | 'B';
  nets?: [string, string];
}

export function pcb(opts: {
  footprints: FpSpec[];
  tracks?: { x1: number; y1: number; x2: number; y2: number; net: number; layer?: string }[];
  vias?: { x: number; y: number; net: number }[];
  outline?: [number, number, number, number];
}): string {
  const nets = ['', 'GND', 'VCC', 'SIG'];
  const netIdx = (name: string) => Math.max(0, nets.indexOf(name));
  const fps = opts.footprints
    .map((f) => {
      const [n1, n2] = f.nets ?? ['GND', 'VCC'];
      const side = f.side ?? 'F';
      return `
  (footprint "Resistor_SMD:R_0603" (layer "${side}.Cu") (uuid "${f.uuid}") (at ${f.x} ${f.y} ${f.rot ?? 0})
    (property "Reference" "${f.ref}" (at 0 -1.5 0) (layer "${side}.SilkS"))
    (property "Value" "${f.value}" (at 0 1.5 0) (layer "${side}.Fab"))
    (attr smd)
    (fp_line (start -1.5 -0.7) (end 1.5 -0.7) (layer "${side}.CrtYd"))
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "${side}.Cu" "${side}.Mask") (net ${netIdx(n1)} "${n1}"))
    (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (layers "${side}.Cu" "${side}.Mask") (net ${netIdx(n2)} "${n2}")))`;
    })
    .join('');
  const tracks = (opts.tracks ?? [])
    .map((t, i) => `\n  (segment (start ${t.x1} ${t.y1}) (end ${t.x2} ${t.y2}) (width 0.25) (layer "${t.layer ?? 'F.Cu'}") (net ${t.net}) (uuid "t${i}-${t.x1}-${t.y1}"))`)
    .join('');
  const vias = (opts.vias ?? [])
    .map((v, i) => `\n  (via (at ${v.x} ${v.y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${v.net}) (uuid "v${i}"))`)
    .join('');
  const [x1, y1, x2, y2] = opts.outline ?? [0, 0, 50, 40];
  return `(kicad_pcb (version 20241229) (generator "pcbnew") (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user) (33 "B.Fab" user))
${nets.map((n, i) => `  (net ${i} "${n}")`).join('\n')}
  (gr_rect (start ${x1} ${y1}) (end ${x2} ${y2}) (layer "Edge.Cuts") (uuid "outline"))${fps}${tracks}${vias})`;
}
