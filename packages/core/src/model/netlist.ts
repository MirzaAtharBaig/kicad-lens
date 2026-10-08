import { child, children, childStr, parseSExpr, tag } from '../sexpr';

export interface NetNode {
  ref: string;
  pin: string;
}

export interface Netlist {
  /** Net name → member pins as `REF.PIN`, sorted. */
  nets: Map<string, string[]>;
}

/** Parse the output of `kicad-cli sch export netlist --format kicadsexpr`. */
export function parseNetlist(text: string): Netlist {
  const root = parseSExpr(text);
  if (tag(root) !== 'export') throw new Error('Not a KiCad netlist');
  const nets = new Map<string, string[]>();
  for (const n of children(child(root, 'nets') ?? [], 'net')) {
    const name = childStr(n, 'name') ?? '';
    const pins = children(n, 'node')
      .map((nd) => `${childStr(nd, 'ref') ?? '?'}.${childStr(nd, 'pin') ?? '?'}`)
      .sort();
    nets.set(name, pins);
  }
  return { nets };
}
