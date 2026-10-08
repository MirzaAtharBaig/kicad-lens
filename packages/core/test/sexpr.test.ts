import { describe, expect, it } from 'vitest';
import { Sym, child, children, flag, num, parseSExpr, str, tag } from '../src/sexpr';

describe('parseSExpr', () => {
  it('parses lists, symbols, numbers and strings', () => {
    const e = parseSExpr('(kicad_sch (version 20250114) (generator "eeschema") (at 1.5 -2 90) (dnp no))');
    expect(tag(e)).toBe('kicad_sch');
    expect(num(child(e, 'version'))).toBe(20250114);
    expect(str(child(e, 'generator'))).toBe('eeschema');
    expect(child(e, 'at')).toEqual([expect.any(Sym), 1.5, -2, 90]);
    expect(flag(e, 'dnp')).toBe(false);
  });

  it('keeps quoted numbers as strings and handles escapes', () => {
    const e = parseSExpr('(pad "1" (net 3 "Net-(\\"U1\\")\\nx"))');
    expect(str(e)).toBe('1');
    expect(typeof e[1]).toBe('string');
    expect(str(child(e, 'net'), 2)).toBe('Net-("U1")\nx');
  });

  it('handles CRLF and tabs', () => {
    const e = parseSExpr('(a\r\n\t(b 1)\r\n\t(b 2)\r\n)');
    expect(children(e, 'b').map((b) => num(b))).toEqual([1, 2]);
  });

  it('treats legacy bare flags as true', () => {
    expect(flag(parseSExpr('(effects (font (size 1 1)) hide)'), 'hide')).toBe(true);
    expect(flag(parseSExpr('(effects (hide yes))'), 'hide')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseSExpr('(a (b)')).toThrow(/Unclosed/);
    expect(() => parseSExpr('(a))')).toThrow(/Unbalanced/);
    expect(() => parseSExpr('(a "x)')).toThrow(/Unterminated/);
  });
});
