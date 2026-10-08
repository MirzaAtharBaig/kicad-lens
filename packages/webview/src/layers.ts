/** KiCad-like default layer colours, stacking order and visibility. */

const COLORS: Record<string, string> = {
  'F.Cu': '#c83434',
  'B.Cu': '#4d7fc4',
  'In1.Cu': '#7fc87f',
  'In2.Cu': '#ce7d2c',
  'In3.Cu': '#4fcbcb',
  'In4.Cu': '#db628b',
  'In5.Cu': '#a7a5c6',
  'In6.Cu': '#c2c200',
  'F.SilkS': '#f2eda1',
  'B.SilkS': '#e8b2a7',
  'F.Mask': '#d864ff',
  'B.Mask': '#02ffee',
  'F.Paste': '#b4a0a0',
  'B.Paste': '#00c2c2',
  'F.Adhes': '#844784',
  'B.Adhes': '#0000b5',
  'F.CrtYd': '#ff26e2',
  'B.CrtYd': '#26e9ff',
  'F.Fab': '#afafaf',
  'B.Fab': '#585d84',
  'Edge.Cuts': '#d0d2cd',
  Margin: '#ff26e2',
  'Dwgs.User': '#c2c2c2',
  'Cmts.User': '#5994dc',
  'Eco1.User': '#b4dbd2',
  'Eco2.User': '#d8c852',
};

const INNER = ['#7fc87f', '#ce7d2c', '#4fcbcb', '#db628b', '#a7a5c6', '#c2c200', '#c27a7a', '#7a7ac2'];

export function layerColor(name: string): string {
  const c = COLORS[name];
  if (c) return c;
  const m = /^In(\d+)\.Cu$/.exec(name);
  if (m) return INNER[(Number(m[1]) - 1) % INNER.length]!;
  return '#9a9a9a';
}

export function defaultVisible(name: string): boolean {
  return /\.Cu$/.test(name) || /\.SilkS$/.test(name) || name === 'Edge.Cuts';
}

export function defaultOpacity(name: string): number {
  if (/\.Mask$/.test(name)) return 0.4;
  if (/\.Cu$/.test(name)) return 0.85;
  return 1;
}

/** Sort key: lower draws first (further back). `flipped` views the board from below. */
export function stackOrder(name: string, flipped: boolean): number {
  const side = name.startsWith('F.') ? 1 : name.startsWith('B.') ? -1 : 0;
  const inner = /^In(\d+)\.Cu$/.exec(name);
  let base: number;
  if (inner) base = 100 - Number(inner[1]); // In1 nearer the front than In2
  else if (side === 0) base = name === 'Edge.Cuts' ? 1000 : 900;
  else {
    const rank = ['Fab', 'CrtYd', 'Adhes', 'Paste', 'Mask', 'SilkS', 'Cu'];
    const r = rank.findIndex((k) => name.endsWith(k));
    base = 200 + (rank.length - r) * 10;
  }
  if (inner || side === 0) return flipped && inner ? 200 - base : base;
  const front = flipped ? side < 0 : side > 0;
  return front ? 500 + base : 300 - base;
}
