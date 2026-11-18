import { SITE } from '../config';

export type ToolPage = {
  mode: 'anagram' | 'words' | 'pair';
  path: string;
  name: string;
  blurb: string;
};

/** The three dedicated tool landing pages, used for cross-links and nav. */
export const TOOL_PAGES: ToolPage[] = [
  { mode: 'anagram', path: '/anagram-solver/', name: 'Anagram Solver', blurb: 'Turn a word, name or phrase into new multi-word phrases.' },
  { mode: 'words', path: '/word-finder/', name: 'Word Finder', blurb: 'List every word you can spell from a set of letters.' },
  { mode: 'pair', path: '/anagram-checker/', name: 'Anagram Checker', blurb: 'Check whether two words or phrases use exactly the same letters.' },
];

export const absolute = (path: string) => new URL(path, SITE.url).href;
