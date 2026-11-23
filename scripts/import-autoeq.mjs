// Regenerates shared/data/measured-headphones.json from the AutoEq project
// (https://github.com/jaakkopasanen/AutoEq, MIT licence). Each entry is the
// published parametric correction for one measured headphone model, so these
// profiles are labelled "Measured" in the app, with their source credited.
//   node scripts/import-autoeq.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
const SOURCE_PRIORITY = ['oratory1990', 'Rtings', 'crinacle', 'Super Review', 'HypetheSonics', 'Innerfidelity'];

// [brand, exact AutoEq name, category, name patterns used for auto-detection]
const WANTED = [
  ['Apple', 'Apple AirPods Max', 'headphones', ['airpods max']],
  ['Apple', 'Apple AirPods Pro', 'earbuds', ['airpods pro(?! ?2)']],
  ['Apple', 'Apple AirPods Pro2', 'earbuds', ['airpods pro ?2']],
  ['Apple', 'Apple AirPods (2nd generation)', 'earbuds', ['^airpods$', "airpods \\(2"]],
  ['Apple', 'Apple AirPods (3rd generation)', 'earbuds', ["airpods \\(3", 'airpods 3']],
  ['Apple', 'Apple AirPods 4', 'earbuds', ['airpods 4']],
  ['Apple', 'Apple EarPods', 'earbuds', ['earpods']],
  ['Beats', 'Beats Studio3 Wireless', 'headphones', ['beats studio ?3']],
  ['Beats', 'Beats Studio Pro', 'headphones', ['beats studio pro']],
  ['Beats', 'Beats Solo Pro', 'headphones', ['beats solo pro']],
  ['Beats', 'Beats Powerbeats Pro', 'earbuds', ['powerbeats pro']],
  ['Beats', 'Beats Studio Buds', 'earbuds', ['studio buds(?! ?\\+)']],
  ['Bose', 'Bose QuietComfort 35 II', 'headphones', ['qc ?35', 'quietcomfort 35']],
  ['Bose', 'Bose QuietComfort 45', 'headphones', ['qc ?45', 'quietcomfort 45']],
  ['Bose', 'Bose QuietComfort Ultra Headphones', 'headphones', ['qc ultra headphones', 'quietcomfort ultra headphones']],
  ['Bose', 'Bose Noise Cancelling Headphones 700', 'headphones', ['bose 700', 'headphones 700']],
  ['Bose', 'Bose QuietComfort Earbuds II', 'earbuds', ['qc earbuds ii', 'quietcomfort earbuds ii']],
  ['JBL', 'JBL Tune 760NC', 'headphones', ['tune 760']],
  ['JBL', 'JBL Live 660NC', 'headphones', ['live 660']],
  ['JBL', 'JBL Tour One', 'headphones', ['tour one(?! m2)']],
  ['JBL', 'JBL Tune 510BT', 'headphones', ['tune 510']],
  ['Samsung', 'Samsung Galaxy Buds Pro', 'earbuds', ['buds pro(?! ?2)']],
  ['Samsung', 'Samsung Galaxy Buds2 Pro', 'earbuds', ['buds ?2 pro']],
  ['Samsung', 'Samsung Galaxy Buds Live', 'earbuds', ['buds live']],
  ['Samsung', 'Samsung Galaxy Buds2', 'earbuds', ['buds ?2(?! pro)']],
  ['Sennheiser', 'Sennheiser Momentum 4 Wireless', 'headphones', ['momentum 4']],
  ['Sennheiser', 'Sennheiser HD 600', 'headphones', ['hd ?600']],
  ['Sennheiser', 'Sennheiser HD 650', 'headphones', ['hd ?650']],
  ['Sony', 'Sony WH-1000XM3', 'headphones', ['wh-1000xm3']],
  ['Sony', 'Sony WH-1000XM4', 'headphones', ['wh-1000xm4']],
  ['Sony', 'Sony WH-1000XM5', 'headphones', ['wh-1000xm5']],
  ['Sony', 'Sony WF-1000XM4', 'earbuds', ['wf-1000xm4']],
  ['Sony', 'Sony WF-1000XM5', 'earbuds', ['wf-1000xm5']],
  ['Sony', 'Sony WH-CH720N', 'headphones', ['wh-ch720']],
  ['Sony', 'Sony MDR-7506', 'headphones', ['mdr-7506']],
];

const TYPES = { PK: 0, LSC: 1, HSC: 2, LPQ: 3, HPQ: 4 };

const index = await (await fetch(RAW + 'INDEX.md')).text();
const entries = [];
for (const line of index.split('\n')) {
  const m = line.match(/^- \[(.+?)\]\(\.\/(.+?)\) by (.+?)(?: on (.+))?$/);
  if (m) entries.push({ name: m[1], path: decodeURIComponent(m[2]), source: m[3], rig: m[4] ?? '' });
}

const out = [];
for (const [brand, name, category, patterns] of WANTED) {
  const candidates = entries
    .filter((e) => e.name.toLowerCase() === name.toLowerCase())
    .sort((a, b) => rank(a.source) - rank(b.source));
  if (!candidates.length) {
    console.warn(`  skip ${name}: not in AutoEq index`);
    continue;
  }
  const c = candidates[0];
  const folder = c.path.split('/').pop();
  const url = RAW + encodeURI(`${c.path}/${folder} ParametricEQ.txt`).replace(/#/g, '%23');
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  skip ${name}: ${res.status}`);
    continue;
  }
  const text = await res.text();
  const preamp = Number(text.match(/Preamp:\s*(-?[\d.]+)/)?.[1] ?? 0);
  const filters = [];
  for (const f of text.matchAll(/Filter \d+: ON (\w+) Fc ([\d.]+) Hz Gain (-?[\d.]+) dB Q ([\d.]+)/g)) {
    if (!(f[1] in TYPES)) continue;
    filters.push({ type: TYPES[f[1]], freq: Number(f[2]), gainDb: Number(f[3]), q: Number(f[4]) });
  }
  const model = name.replace(new RegExp(`^${brand} `), '');
  out.push({
    id: 'measured:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    brand,
    model,
    category,
    channels: '2.0',
    verification: 'measured',
    source: `${c.source}${c.rig ? ' on ' + c.rig : ''} via AutoEq`,
    sourceUrl: `https://github.com/jaakkopasanen/AutoEq/tree/master/results/${encodeURI(c.path)}`,
    match: patterns,
    preampDb: preamp,
    filters,
  });
  console.log(`  ✓ ${name} (${c.source}, ${filters.length} filters)`);
}

const file = path.join(root, 'shared', 'data', 'measured-headphones.json');
writeFileSync(file, JSON.stringify({ generatedFrom: 'AutoEq (MIT) https://github.com/jaakkopasanen/AutoEq', profiles: out }, null, 2) + '\n');
console.log(`✓ ${out.length} measured profiles → ${path.relative(root, file)}`);

function rank(source) {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i < 0 ? 99 : i;
}
