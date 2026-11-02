// PROTOTYPE helper: evaluate candidate palettes for ticket 34.
// Usage: node eval.mjs  (prints hex values and checks for each palette)
export const SURF = { bg: '#1a1220', surface: '#261b2f', row: '#33253e' };
export const DARK_TEXT = '#1a1220';

const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export const hexToLin = h => [1, 3, 5].map(i => toLin(parseInt(h.slice(i, i + 2), 16) / 255));
const clamp = x => Math.min(1, Math.max(0, x));
export const linToHex = l => '#' + l.map(c => Math.round(clamp(toSrgb(clamp(c))) * 255).toString(16).padStart(2, '0')).join('');

export function oklchToHex(L, C, H) {
  const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return linToHex([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ]);
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
export const lum = h => { const [r, g, b] = hexToLin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// Machado et al. 2009, severity 1.0, applied in linear RGB.
export const CVD = {
  normal: null,
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.302900]]
};
const sim = (h, M) => { const l = hexToLin(h); return M ? M.map(r => clamp(r[0] * l[0] + r[1] * l[1] + r[2] * l[2])) : l; };
export const dE = (a, b, M) => { const p = linToOklab(sim(a, M)), q = linToOklab(sim(b, M)); return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

export function report(name, P) {
  const avail = ['yes', 'maybe', 'no'], av = Object.keys(P.avatar);
  const out = [`== ${name}`];
  const fails = [];
  for (const k of avail) {
    const c = P[k];
    const t = Math.min(...Object.values(SURF).map(s => contrast(c, s)));
    const fill = contrast(DARK_TEXT, c);
    out.push(`${k.padEnd(6)} ${c} text-on-surfaces min ${t.toFixed(2)}  dark-text-on-fill ${fill.toFixed(2)}`);
    if (t < 4.5) fails.push(`${k} text ${t.toFixed(2)}`); if (fill < 4.5) fails.push(`${k} fill ${fill.toFixed(2)}`);
  }
  for (const m of Object.keys(CVD)) {
    const d = [];
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) d.push(dE(P[avail[i]], P[avail[j]], CVD[m]));
    out.push(`  avail-vs-avail ${m.padEnd(6)} min dE ${Math.min(...d).toFixed(1)}`);
  }
  for (const a of av) {
    const c = P.avatar[a];
    const dot = Math.min(...Object.values(SURF).map(s => contrast(c, s)));
    const per = Object.keys(CVD).map(m => Math.min(...avail.map(k => dE(c, P[k], CVD[m]))).toFixed(0).padStart(3)).join(' ');
    out.push(`${a.padEnd(7)} ${c} dot ${dot.toFixed(2)}  min dE to Y/M/N [n p d t] ${per}`);
    if (dot < 3) fails.push(`${a} dot ${dot.toFixed(2)}`);
  }
  out.push(`  FAILS: ${fails.join(', ') || 'none'}`);
  return out.join('\n');
}

export function build(spec) {
  const o = { avatar: {} };
  for (const k of ['yes', 'maybe', 'no']) o[k] = oklchToHex(...spec[k]);
  for (const [k, v] of Object.entries(spec.avatar)) o.avatar[k] = oklchToHex(...v);
  return o;
}

// Candidate specs in OKLCH [L, C, H].
export const SPECS = {
  'Bright': {
    yes: [0.80, 0.19, 148], maybe: [0.84, 0.16, 82], no: [0.72, 0.17, 25],
    avatar: { blue: [0.68, 0.16, 258], sky: [0.76, 0.12, 232], cyan: [0.78, 0.11, 205], indigo: [0.66, 0.16, 278],
      violet: [0.70, 0.17, 298], purple: [0.70, 0.20, 318], pink: [0.74, 0.17, 350], slate: [0.70, 0.035, 255] }
  },
  'Soft': {
    yes: [0.84, 0.14, 152], maybe: [0.86, 0.12, 85], no: [0.76, 0.13, 22],
    avatar: { blue: [0.74, 0.11, 258], sky: [0.82, 0.08, 232], cyan: [0.82, 0.08, 205], indigo: [0.72, 0.11, 280],
      violet: [0.76, 0.12, 300], purple: [0.76, 0.14, 320], pink: [0.80, 0.11, 352], slate: [0.74, 0.03, 260] }
  },
  'Signal': {
    yes: [0.82, 0.21, 145], maybe: [0.87, 0.17, 90], no: [0.70, 0.20, 30],
    avatar: { blue: [0.64, 0.17, 262], sky: [0.72, 0.13, 240], cyan: [0.74, 0.12, 215], indigo: [0.60, 0.17, 280],
      violet: [0.64, 0.19, 300], purple: [0.64, 0.21, 320], pink: [0.70, 0.19, 355], slate: [0.64, 0.03, 260] }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [n, s] of Object.entries(SPECS)) console.log(report(n, build(s)) + '\n');
}
