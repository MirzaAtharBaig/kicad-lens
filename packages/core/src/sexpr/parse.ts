/**
 * Minimal, fast S-expression parser for KiCad files.
 *
 * Lists become arrays, quoted strings become `string`, bare atoms become
 * `Sym` (so `yes` and `"yes"` stay distinguishable) and numeric bare atoms
 * become `number`.
 */

export class Sym {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

export type SAtom = string | number | Sym;
export type SExpr = SAtom | SList;
export type SList = SExpr[];

const symCache = new Map<string, Sym>();
function sym(name: string): Sym {
  let s = symCache.get(name);
  if (!s) {
    s = new Sym(name);
    symCache.set(name, s);
  }
  return s;
}

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export class SExprParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
  }
}

export function parseSExpr(text: string): SList {
  const stack: SList[] = [];
  let root: SList | undefined;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x28 /* ( */) {
      const list: SList = [];
      const top = stack[stack.length - 1];
      if (top) top.push(list);
      else if (root) throw new SExprParseError('Multiple top-level expressions', i);
      else root = list;
      stack.push(list);
      i++;
    } else if (c === 0x29 /* ) */) {
      if (!stack.pop()) throw new SExprParseError('Unbalanced )', i);
      i++;
    } else if (c === 0x22 /* " */) {
      i++;
      let out = '';
      let start = i;
      for (;;) {
        if (i >= n) throw new SExprParseError('Unterminated string', start);
        const d = text.charCodeAt(i);
        if (d === 0x22) break;
        if (d === 0x5c /* \ */) {
          out += text.slice(start, i);
          const e = text[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '');
          i += 2;
          start = i;
        } else {
          i++;
        }
      }
      out += text.slice(start, i);
      i++;
      const top = stack[stack.length - 1];
      if (!top) throw new SExprParseError('String outside list', i);
      top.push(out);
    } else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i++;
    } else {
      const start = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 0x28 || d === 0x29 || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d || d === 0x22) break;
        i++;
      }
      const tok = text.slice(start, i);
      const top = stack[stack.length - 1];
      if (!top) throw new SExprParseError('Atom outside list', start);
      top.push(NUMBER_RE.test(tok) ? Number(tok) : sym(tok));
    }
  }
  if (stack.length) throw new SExprParseError('Unclosed (', n);
  if (!root) throw new SExprParseError('Empty input', 0);
  return root;
}
