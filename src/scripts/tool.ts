import { DEFAULT_OPTIONS, isAnagramPair, normalize, parseWordList } from '../lib/solver';

type Mode = 'anagram' | 'words' | 'pair';
type Saved = { mode: Mode; q: string; b?: string };
type Favorite = { text: string; source: string };

const MODES: Mode[] = ['anagram', 'words', 'pair'];
const PAGE = 100;
const HISTORY_KEY = 'ag:history';
const FAVORITES_KEY = 'ag:favorites';

const root = document.querySelector<HTMLElement>('[data-tool]');
if (root) init(root);

function init(root: HTMLElement) {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = $<HTMLFormElement>('[data-form]');
  const qInput = form.elements.namedItem('q') as HTMLInputElement;
  const bInput = form.elements.namedItem('b') as HTMLInputElement;
  const output = $('[data-output]');
  const status = $('[data-status]');
  const toolbar = $('[data-toolbar]');
  const resultsEl = $('[data-results]');
  const moreWrap = $('[data-more-wrap]');
  const tilesEl = $('[data-tiles]');
  const countEl = $('[data-count]');
  const shuffleBtn = $<HTMLButtonElement>('[data-shuffle]');
  const sortSel = $<HTMLSelectElement>('[data-sort]');
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];

  let mode: Mode = 'anagram';
  let phrases: string[] = []; // current result rows as text, for copy/export
  let shown = 0;
  let worker: Worker | null = null;
  let seq = 0;
  let pending = 0;
  let debounce: number | undefined;
  let timer: number | undefined;
  let tileOrder: string[] = [];

  /* ---------- storage ---------- */
  const read = <T,>(key: string, fallback: T): T => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '') as T;
    } catch {
      return fallback;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: features degrade silently */
    }
  };

  /* ---------- helpers ---------- */
  const say = (text: string) => (status.textContent = text);
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const num = (name: string, fallback: number, min: number, max: number) => {
    const v = Math.round(Number(field(name).value));
    return Number.isFinite(v) && field(name).value !== '' ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const icon = (path: string) =>
    `<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICON_COPY = icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>');
  const ICON_STAR = icon('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>');

  async function copy(text: string, message = 'Copied to clipboard.') {
    try {
      await navigator.clipboard.writeText(text);
      say(message);
    } catch {
      say('Copy failed. Select the text and copy it manually.');
    }
  }

  function download(name: string, type: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------- mode + URL state ---------- */
  function setMode(next: Mode, focus = false) {
    mode = next;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === next)));
    form.setAttribute('aria-labelledby', `tab-${next}`);
    root.querySelectorAll<HTMLElement>('[data-modes]').forEach((el) => {
      el.hidden = !el.dataset.modes!.split(' ').includes(next);
    });
    $('[data-label-q]').textContent = next === 'pair' ? 'First phrase' : 'Your word or phrase';
    $('[data-hint-q]').hidden = next === 'pair';
    $<HTMLButtonElement>('[data-submit]').textContent =
      next === 'anagram' ? 'Generate' : next === 'words' ? 'Find Words' : 'Check';
    if (focus) qInput.focus();
  }

  function stateToParams(): URLSearchParams {
    const p = new URLSearchParams();
    const q = qInput.value.trim();
    if (!q) return p;
    p.set('q', q);
    if (mode !== 'anagram') p.set('mode', mode);
    if (mode === 'pair') {
      if (bInput.value.trim()) p.set('b', bInput.value.trim());
      return p;
    }
    const set = (key: string, value: string, def: string) => value !== def && value !== '' && p.set(key, value);
    if (mode === 'anagram') {
      set('minw', field('minw').value, String(DEFAULT_OPTIONS.minWords));
      set('maxw', field('maxw').value, String(DEFAULT_OPTIONS.maxWords));
      set('minl', field('minl').value, String(DEFAULT_OPTIONS.minWordLength));
      set('max', field('max').value, String(DEFAULT_OPTIONS.maxResults));
      set('inc', field('inc').value.trim(), '');
      set('exc', field('exc').value.trim(), '');
    } else {
      set('scope', field('scope').value, 'within');
      set('sw', field('sw').value.trim(), '');
      set('ew', field('ew').value.trim(), '');
    }
    if (!field('common').checked) p.set('common', '0');
    return p;
  }

  function paramsToState(p: URLSearchParams) {
    const m = p.get('mode') as Mode | null;
    setMode(m && MODES.includes(m) ? m : 'anagram');
    qInput.value = p.get('q') ?? '';
    bInput.value = p.get('b') ?? '';
    for (const key of ['minw', 'maxw', 'minl', 'max', 'inc', 'exc', 'scope', 'sw', 'ew']) {
      if (p.has(key)) field(key).value = p.get(key)!;
    }
    if (p.get('common') === '0') field('common').checked = false;
    if (p.has('inc') || p.has('exc') || p.has('sw') || p.has('ew') || p.has('scope') || p.has('minw') || p.has('maxw')) {
      $<HTMLDetailsElement>('[data-options]').open = true;
    }
  }

  function syncUrl() {
    const qs = stateToParams().toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  }

  /* ---------- letter tiles ---------- */
  function renderTiles(shuffle = false) {
    const letters = [...normalize(qInput.value)];
    const same = letters.length === tileOrder.length && [...letters].sort().join('') === [...tileOrder].sort().join('');
    if (!same || !shuffle) tileOrder = letters;
    if (shuffle) {
      for (let i = tileOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tileOrder[i], tileOrder[j]] = [tileOrder[j], tileOrder[i]];
      }
    }
    tilesEl.replaceChildren(
      ...tileOrder.slice(0, 40).map((l) => Object.assign(document.createElement('span'), { className: 'tile', textContent: l })),
    );
    countEl.textContent = letters.length ? `${letters.length} letter${letters.length === 1 ? '' : 's'}` : '';
    shuffleBtn.hidden = letters.length < 2;
  }

  /* ---------- worker ---------- */
  function ensureWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL('../workers/solver.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = onResult;
      worker.onerror = () => {
        pending = 0;
        say('Something went wrong loading the dictionary. Please refresh and try again.');
      };
    }
    return worker;
  }

  function request(payload: Record<string, unknown>) {
    if (pending && worker) {
      worker.terminate(); // abandon a long-running stale search
      worker = null;
    }
    pending = ++seq;
    output.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => pending && say('Searching…'), 150);
    ensureWorker().postMessage({ ...payload, id: pending, base: import.meta.env.BASE_URL });
  }

  function onResult(event: MessageEvent) {
    const data = event.data;
    if (data.id !== seq) return;
    pending = 0;
    window.clearTimeout(timer);
    if (data.type === 'error') {
      say(`Search failed: ${data.message}`);
      return;
    }
    output.hidden = false;
    toolbar.hidden = false;
    if (data.type === 'anagram') {
      phrases = (data.anagrams as string[][]).map((a) => a.join(' '));
      const n = phrases.length;
      const note = data.timedOut ? ' Search stopped early; narrow the options for more.' : data.truncated ? ' Showing the first batch; raise Max Results for more.' : '';
      say(n ? `${n.toLocaleString()} anagram${n === 1 ? '' : 's'} found.${note}` : 'No anagrams found. Try more words, shorter minimum length, or turn off “Common words only”.');
      renderRows(false);
    } else {
      const words = data.words as string[];
      phrases = words;
      say(words.length ? `${words.length.toLocaleString()} word${words.length === 1 ? '' : 's'} found.` : 'No words found for these letters and filters.');
      renderRows(true);
    }
  }

  /* ---------- results ---------- */
  function sorted(): string[] {
    return sortSel.value === 'alpha' && mode === 'anagram' ? [...phrases].sort((a, b) => a.localeCompare(b)) : phrases;
  }

  function renderRows(grouped: boolean) {
    shown = 0;
    resultsEl.replaceChildren();
    resultsEl.dataset.grouped = String(grouped);
    resultsEl.dataset.lastLen = '0';
    sortSel.hidden = mode !== 'anagram';
    appendRows();
  }

  function appendRows() {
    const rows = sorted();
    const grouped = resultsEl.dataset.grouped === 'true';
    const frag = document.createDocumentFragment();
    const favs = new Set(read<Favorite[]>(FAVORITES_KEY, []).map((f) => f.text));
    let lastLen = grouped ? Number(resultsEl.dataset.lastLen ?? 0) : 0;
    for (const text of rows.slice(shown, shown + PAGE)) {
      if (grouped && text.length !== lastLen) {
        lastLen = text.length;
        const h = document.createElement('div');
        h.className = 'eyebrow sticky top-0 border-b border-hairline bg-canvas px-4 py-2 sm:px-6';
        h.textContent = `${lastLen} letters`;
        frag.append(h);
      }
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 border-b border-hairline-soft px-4 py-1.5 last:border-b-0 sm:px-6';
      const label = document.createElement('span');
      label.className = 'mr-auto min-w-0 font-mono text-sm break-words text-ink';
      label.textContent = text;
      if (!grouped) {
        const n = document.createElement('span');
        n.className = 'ml-2 text-xs text-faint';
        n.textContent = `${text.split(' ').length}w`;
        label.append(n);
      }
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'btn btn-icon border-transparent bg-transparent';
      star.dataset.star = text;
      star.setAttribute('aria-label', `Favorite “${text}”`);
      star.setAttribute('aria-pressed', String(favs.has(text)));
      star.innerHTML = ICON_STAR;
      const cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'btn btn-icon border-transparent bg-transparent';
      cp.dataset.copy = text;
      cp.setAttribute('aria-label', `Copy “${text}”`);
      cp.innerHTML = ICON_COPY;
      row.append(label, star, cp);
      frag.append(row);
    }
    resultsEl.dataset.lastLen = String(lastLen);
    resultsEl.append(frag);
    shown = Math.min(rows.length, shown + PAGE);
    moreWrap.hidden = shown >= rows.length;
  }

  /* ---------- run ---------- */
  function run(push = true) {
    const q = qInput.value.trim();
    renderTiles();
    if (!normalize(q)) {
      pending = 0;
      output.hidden = true;
      syncUrl();
      return;
    }
    if (push) saveHistory();
    syncUrl();
    if (mode === 'pair') {
      const b = bInput.value.trim();
      output.hidden = false;
      toolbar.hidden = true;
      moreWrap.hidden = true;
      resultsEl.replaceChildren();
      if (!normalize(b)) {
        say('Enter a second phrase to compare.');
        return;
      }
      const yes = isAnagramPair(q, b);
      say(yes ? `Yes. “${q}” and “${b}” are anagrams of each other.` : `No. “${q}” and “${b}” use different letters.`);
      return;
    }
    if (mode === 'anagram') {
      const minWords = num('minw', DEFAULT_OPTIONS.minWords, 1, 10);
      request({
        type: 'anagram',
        input: q,
        options: {
          minWords,
          maxWords: Math.max(minWords, num('maxw', DEFAULT_OPTIONS.maxWords, 1, 10)),
          minWordLength: num('minl', DEFAULT_OPTIONS.minWordLength, 1, 10),
          maxResults: num('max', DEFAULT_OPTIONS.maxResults, 10, 1000),
          include: parseWordList(field('inc').value),
          exclude: parseWordList(field('exc').value),
          commonOnly: field('common').checked,
        },
      });
    } else {
      request({
        type: 'words',
        input: q,
        options: {
          mode: field('scope').value,
          startsWith: field('sw').value,
          endsWith: field('ew').value,
          commonOnly: field('common').checked,
        },
      });
    }
  }

  function schedule() {
    window.clearTimeout(debounce);
    renderTiles();
    debounce = window.setTimeout(() => run(false), 300);
  }

  /* ---------- history + favorites ---------- */
  function saveHistory() {
    const entry: Saved = { mode, q: qInput.value.trim(), ...(mode === 'pair' ? { b: bInput.value.trim() } : {}) };
    const list = read<Saved[]>(HISTORY_KEY, []).filter((h) => !(h.q === entry.q && h.mode === entry.mode && h.b === entry.b));
    write(HISTORY_KEY, [entry, ...list].slice(0, 12));
    renderSaved();
  }

  function chip(label: string, attrs: Record<string, string>) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn !h-8 font-mono !text-xs';
    b.textContent = label;
    Object.assign(b.dataset, attrs);
    li.append(b);
    return li;
  }

  function renderSaved() {
    const history = read<Saved[]>(HISTORY_KEY, []);
    const favorites = read<Favorite[]>(FAVORITES_KEY, []);
    const tag = (s: Saved) => (s.mode === 'anagram' ? '' : s.mode === 'words' ? ' · words' : ` ↔ ${s.b}`);
    $('[data-history]').replaceChildren(
      ...history.map((h, i) => chip(`${h.q}${tag(h)}`, { history: String(i) })),
    );
    $('[data-favorites]').replaceChildren(...favorites.map((f, i) => chip(f.text, { favorite: String(i) })));
    $<HTMLElement>('[data-history-empty]').hidden = history.length > 0;
    $<HTMLElement>('[data-clear-history]').hidden = history.length === 0;
    $<HTMLElement>('[data-favorites-empty]').hidden = favorites.length > 0;
    $<HTMLElement>('[data-clear-favorites]').hidden = favorites.length === 0;
  }

  function restore(s: Saved) {
    setMode(s.mode);
    qInput.value = s.q;
    bInput.value = s.b ?? '';
    run(false);
    root.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  /* ---------- events ---------- */
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    window.clearTimeout(debounce);
    run(true);
  });
  form.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLInputElement).type === 'checkbox') run(false);
    else schedule();
  });
  sortSel.addEventListener('change', () => renderRows(false));

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      setMode(tab.dataset.mode as Mode);
      output.hidden = true;
      if (qInput.value.trim()) run(false);
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
  });

  $('[data-clear]').addEventListener('click', () => {
    qInput.value = '';
    bInput.value = '';
    output.hidden = true;
    pending = 0;
    renderTiles();
    syncUrl();
    qInput.focus();
  });
  shuffleBtn.addEventListener('click', () => renderTiles(true));
  $('[data-more]').addEventListener('click', appendRows);

  resultsEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target) return;
    if (target.dataset.copy) copy(target.dataset.copy, `Copied “${target.dataset.copy}”.`);
    if (target.dataset.star) {
      const text = target.dataset.star;
      const favs = read<Favorite[]>(FAVORITES_KEY, []);
      const exists = favs.some((f) => f.text === text);
      write(FAVORITES_KEY, exists ? favs.filter((f) => f.text !== text) : [{ text, source: qInput.value.trim() }, ...favs].slice(0, 50));
      target.setAttribute('aria-pressed', String(!exists));
      say(exists ? `Removed “${text}” from favorites.` : `Saved “${text}” to favorites.`);
      renderSaved();
    }
  });

  toolbar.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    const rows = sorted();
    if (action === 'copy') copy(rows.join('\n'), `Copied ${rows.length.toLocaleString()} results.`);
    if (action === 'txt') download('anagrams.txt', 'text/plain', rows.join('\n'));
    if (action === 'csv') download('anagrams.csv', 'text/csv', ['result', ...rows.map((r) => `"${r.replace(/"/g, '""')}"`)].join('\n'));
    if (action === 'share') copy(location.href, 'Link copied. It reopens this exact search.');
  });

  root.querySelector('[data-saved]')!.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.history) restore(read<Saved[]>(HISTORY_KEY, [])[Number(t.dataset.history)]);
    if (t.dataset.favorite) {
      const f = read<Favorite[]>(FAVORITES_KEY, [])[Number(t.dataset.favorite)];
      if (f) restore({ mode: 'anagram', q: f.source });
    }
    if ('clearHistory' in t.dataset) { write(HISTORY_KEY, []); renderSaved(); }
    if ('clearFavorites' in t.dataset) { write(FAVORITES_KEY, []); renderSaved(); }
  });

  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      root.scrollIntoView({ block: 'center' });
      qInput.focus();
    }
  });

  /* ---------- boot ---------- */
  paramsToState(new URLSearchParams(location.search));
  renderSaved();
  renderTiles();
  if (qInput.value.trim()) run(false);
  else ensureWorker().postMessage({ id: -1, type: 'anagram', input: '', options: {}, base: import.meta.env.BASE_URL }); // warm the dictionary
}
