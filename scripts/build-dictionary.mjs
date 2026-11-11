// Builds public/dict/en.txt (full list) and public/dict/en-common.txt (common subset).
// Source: `word-list` (MIT) + google-10000-english 20k list (scripts/data/common-raw.txt).
import { readFileSync, writeFileSync } from 'node:fs';

const SHORT = new Set(
  'a i ah am an as at aw ax ay be by do ex go ha he hi if in is it me my no of oh ok on or ox so to up us we'.split(' '),
);
const ok = (w) => /^[a-z]+$/.test(w) && w.length <= 24 && (w.length > 2 || SHORT.has(w));

const all = readFileSync('node_modules/word-list/words.txt', 'utf8').split('\n').filter(ok);
const set = new Set(all);
const common = readFileSync('scripts/data/common-raw.txt', 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter((w) => ok(w) && set.has(w) && (w.length > 2 || SHORT.has(w)));

writeFileSync('public/dict/en.txt', all.join('\n'));
writeFileSync('public/dict/en-common.txt', [...new Set(common)].join('\n'));
console.log(`en: ${all.length} words, common: ${new Set(common).size} words`);
