import {
  findAnagrams,
  findWords,
  type AnagramOptions,
  type Dictionary,
  type FinderOptions,
} from '../lib/solver';

type Request =
  | { id: number; base: string; type: 'anagram'; input: string; options: Partial<AnagramOptions> }
  | { id: number; base: string; type: 'words'; input: string; options: FinderOptions };

let dictionary: Promise<Dictionary> | null = null;

function load(base: string): Promise<Dictionary> {
  return Promise.all([
    fetch(`${base}dict/en.txt`).then((r) => r.text()),
    fetch(`${base}dict/en-common.txt`).then((r) => r.text()),
  ]).then(([all, common]) => ({
    words: all.split('\n'),
    common: new Set(common.split('\n')),
  }));
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  try {
    dictionary ??= load(req.base);
    const dict = await dictionary;
    if (req.type === 'anagram') {
      self.postMessage({ id: req.id, type: 'anagram', ...findAnagrams(req.input, dict, req.options) });
    } else {
      self.postMessage({ id: req.id, type: 'words', words: findWords(req.input, dict, req.options) });
    }
  } catch (error) {
    dictionary = null;
    self.postMessage({ id: req.id, type: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
  }
};
