import { Sym, type SExpr, type SList } from './parse';

export function isList(e: SExpr | undefined): e is SList {
  return Array.isArray(e);
}

/** Name of a list's head symbol, e.g. `symbol` for `(symbol ...)`. */
export function tag(e: SExpr | undefined): string | undefined {
  if (!isList(e)) return undefined;
  const h = e[0];
  return h instanceof Sym ? h.name : undefined;
}

export function child(list: SList, name: string): SList | undefined {
  for (const e of list) if (tag(e) === name) return e as SList;
  return undefined;
}

export function children(list: SList, name: string): SList[] {
  const out: SList[] = [];
  for (const e of list) if (tag(e) === name) out.push(e as SList);
  return out;
}

/** The i-th argument (after the head) as a string, or undefined. */
export function str(list: SList | undefined, i = 1): string | undefined {
  const v = list?.[i];
  if (v === undefined || isList(v)) return undefined;
  return v instanceof Sym ? v.name : String(v);
}

export function num(list: SList | undefined, i = 1): number | undefined {
  const v = list?.[i];
  return typeof v === 'number' ? v : undefined;
}

/** Value of `(name value)` child, e.g. childStr(sym, 'lib_id'). */
export function childStr(list: SList, name: string): string | undefined {
  return str(child(list, name));
}

/** KiCad booleans: `(dnp yes)`, `(hide yes)` or legacy bare `hide` flags. */
export function flag(list: SList, name: string): boolean {
  const c = child(list, name);
  if (c) return str(c) !== 'no';
  return list.some((e) => e instanceof Sym && e.name === name);
}

export interface At {
  x: number;
  y: number;
  rot: number;
}

export function at(list: SList): At | undefined {
  const a = child(list, 'at');
  if (!a) return undefined;
  return { x: num(a, 1) ?? 0, y: num(a, 2) ?? 0, rot: num(a, 3) ?? 0 };
}

export function xy(list: SList): { x: number; y: number } {
  return { x: num(list, 1) ?? 0, y: num(list, 2) ?? 0 };
}
