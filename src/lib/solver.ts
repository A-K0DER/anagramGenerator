export interface AnagramOptions {
  maxResults: number;
  minWords: number;
  maxWords: number;
  minWordLength: number;
  include: string[];
  exclude: string[];
  commonOnly: boolean;
  /** Stop searching after this many milliseconds and flag the result as partial. */
  timeBudgetMs: number;
}

export interface AnagramResult {
  anagrams: string[][];
  truncated: boolean;
  timedOut: boolean;
  candidateCount: number;
}

export interface FinderOptions {
  mode: 'within' | 'containing';
  startsWith: string;
  endsWith: string;
  commonOnly: boolean;
}

export interface Dictionary {
  words: string[];
  common: Set<string>;
}

export const DEFAULT_OPTIONS: AnagramOptions = {
  maxResults: 200,
  minWords: 1,
  maxWords: 4,
  minWordLength: 2,
  include: [],
  exclude: [],
  commonOnly: true,
  timeBudgetMs: 6000,
};

const A = 97;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z]/g, '');
}

export function countLetters(letters: string): Int16Array {
  const counts = new Int16Array(26);
  for (let i = 0; i < letters.length; i++) counts[letters.charCodeAt(i) - A]++;
  return counts;
}

export function parseWordList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(normalize)
    .filter(Boolean);
}

function fits(word: string, counts: Int16Array): boolean {
  const used = new Int16Array(26);
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i) - A;
    if (++used[c] > counts[c]) return false;
  }
  return true;
}

/**
 * Finds multi-word anagrams of `input`. Words are chosen in non-decreasing candidate order,
 * so every combination is produced once regardless of word order.
 */
export function findAnagrams(
  input: string,
  dict: Dictionary,
  partial: Partial<AnagramOptions> = {},
): AnagramResult {
  const opts = { ...DEFAULT_OPTIONS, ...partial };
  const letters = normalize(input);
  const result: AnagramResult = { anagrams: [], truncated: false, timedOut: false, candidateCount: 0 };
  if (!letters) return result;

  const counts = countLetters(letters);
  const required = opts.include.map(normalize).filter(Boolean);
  for (const word of required) {
    for (let i = 0; i < word.length; i++) {
      if (--counts[word.charCodeAt(i) - A] < 0) return result; // required words don't fit
    }
  }
  let remaining = 0;
  for (let i = 0; i < 26; i++) remaining += counts[i];

  const excluded = new Set(opts.exclude.map(normalize));
  const candidates: string[] = [];
  const source = opts.commonOnly ? dict.words.filter((w) => dict.common.has(w)) : dict.words;
  for (const word of source) {
    if (word.length > remaining) continue;
    if (word.length < opts.minWordLength && !(word === 'a' || word === 'i')) continue;
    if (excluded.has(word)) continue;
    if (fits(word, counts)) candidates.push(word);
  }
  // Longer words first: fewer-word, more natural results surface before the cap is hit.
  candidates.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  result.candidateCount = candidates.length;

  const picked: string[] = [];
  const deadline = Date.now() + opts.timeBudgetMs;
  let steps = 0;

  const record = () => {
    const words = [...required, ...picked];
    if (words.length < opts.minWords || words.length > opts.maxWords) return;
    result.anagrams.push(words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1)));
  };

  const search = (left: number, start: number): boolean => {
    if (left === 0) {
      record();
      return result.anagrams.length >= opts.maxResults;
    }
    if (required.length + picked.length >= opts.maxWords) return false;
    for (let i = start; i < candidates.length; i++) {
      const word = candidates[i];
      if (word.length > left) continue;
      if (!fits(word, counts)) continue;
      if ((++steps & 1023) === 0 && Date.now() > deadline) {
        result.timedOut = true;
        return true;
      }
      for (let k = 0; k < word.length; k++) counts[word.charCodeAt(k) - A]--;
      picked.push(word);
      const stop = search(left - word.length, i);
      picked.pop();
      for (let k = 0; k < word.length; k++) counts[word.charCodeAt(k) - A]++;
      if (stop) return true;
    }
    return false;
  };

  if (remaining === 0) record();
  else search(remaining, 0);

  result.truncated = result.anagrams.length >= opts.maxResults;
  // Fewest words first, then longest leading word, then alphabetical.
  result.anagrams.sort(
    (a, b) =>
      a.length - b.length ||
      b[0].length - a[0].length ||
      a.join(' ').localeCompare(b.join(' ')),
  );
  return result;
}

/** Word finder: words made from the letters (`within`) or words that contain all of them (`containing`). */
export function findWords(input: string, dict: Dictionary, opts: FinderOptions): string[] {
  const letters = normalize(input);
  if (!letters) return [];
  const counts = countLetters(letters);
  const starts = normalize(opts.startsWith);
  const ends = normalize(opts.endsWith);
  const source = opts.commonOnly ? dict.words.filter((w) => dict.common.has(w)) : dict.words;
  const out: string[] = [];
  for (const word of source) {
    if (starts && !word.startsWith(starts)) continue;
    if (ends && !word.endsWith(ends)) continue;
    if (opts.mode === 'within') {
      if (word.length < 2 || word.length > letters.length) continue;
      if (fits(word, counts)) out.push(word);
    } else {
      if (word.length <= letters.length) continue;
      const need = Int16Array.from(counts);
      let ok = true;
      for (let i = 0; i < word.length; i++) need[word.charCodeAt(i) - A]--;
      for (let i = 0; i < 26; i++) if (need[i] > 0) { ok = false; break; }
      if (ok) out.push(word);
    }
  }
  return out.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

export function isAnagramPair(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return x.length > 0 && x.length === y.length && [...x].sort().join('') === [...y].sort().join('');
}
