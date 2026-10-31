// News Desk: headlines from publisher feeds read through the governed
// `web__fetch_page` tool. Feeds, validated articles, bookmarks and receipts
// live in `context.state`; `view()` derives every surface from them. Articles
// keep their own publication and retrieval times; a failed read keeps the old ones.
import { canonical, parseFeed, sourceBody, type Article } from './feed.ts';

export interface Feed { name: string; category: string; url: string }
export interface Receipt { source: string; url: string; at: string; rows: number; status: string }
export interface State {
  feeds?: Feed[]; newFeed?: Partial<Feed>; category?: string; articles?: Article[]; saved?: string[];
  receipts?: Receipt[]; problem?: string; checkedAt?: string;
}
export interface Context { state: State; surfaces?: Record<string, unknown>; callTool(name: string, args: Record<string, unknown>): Promise<unknown> }
interface Node { id: string; type: string; props?: Record<string, unknown>; children?: string[] | { each: string; template: string } }
interface Update { surface: string; nodes: Node[]; data: { op: 'replace'; path: '/'; value: Record<string, unknown> }[] }

export const DEFAULT_FEEDS: Feed[] = [
  { name: 'BBC World', category: 'World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Business', category: 'Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'BBC Technology', category: 'Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { name: 'BBC Science', category: 'Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
];
const MAX_FEEDS = 6, MAX_SAVED = 60, RECENT = 180, MAX_ARTICLES = 240;
export const TITLES: Record<string, string> = { headlines: 'Headlines', saved: 'Reading list', sources: 'Sources' };
const SETUP = 'In Settings → Integrations, enable Web pages and set fetch_page to Allow.';

// --- canonical state ---------------------------------------------------------------

const line = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, max);
/** One feed from untrusted input; throws a sentence the person can act on. */
export function feed(raw: Partial<Feed>): Feed {
  const name = line(raw?.name, 80), category = line(raw?.category, 40);
  if (!name || !category) throw new Error('Each feed needs a name and a category');
  return { name, category, url: canonical(String(raw.url ?? '').trim()) };
}
const validArticle = (a: Article) => a && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.url === 'string' && typeof a.source === 'string' && typeof a.category === 'string' && typeof a.retrievedAt === 'string';

/** State arrives as untrusted JSON; version 1 kept the feeds as a JSON string. */
export function normalize(s: State): State {
  let raw: unknown = s.feeds;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = undefined; } }
  const feeds = [...new Map((Array.isArray(raw) ? raw : []).flatMap((f) => { try { return [feed(f)]; } catch { return []; } }).map((f) => [f.url, f])).values()].slice(0, MAX_FEEDS);
  const articles = (Array.isArray(s.articles) ? s.articles : []).filter(validArticle).slice(0, MAX_ARTICLES);
  const ids = new Set(articles.map((a) => a.id));
  const nf = s.newFeed && typeof s.newFeed === 'object' ? s.newFeed : {};
  return {
    feeds: feeds.length ? feeds : DEFAULT_FEEDS,
    newFeed: { name: line(nf.name, 80), category: line(nf.category, 40), url: line(nf.url, 500) },
    category: line(s.category, 40) || 'All',
    articles, saved: (Array.isArray(s.saved) ? s.saved : []).filter((id) => ids.has(id)).slice(0, MAX_SAVED),
    receipts: (Array.isArray(s.receipts) ? s.receipts : []).filter((r) => r && typeof r.source === 'string').slice(0, 24),
    problem: typeof s.problem === 'string' ? s.problem.slice(0, 400) : undefined, checkedAt: typeof s.checkedAt === 'string' ? s.checkedAt : undefined,
  };
}

// --- refresh -----------------------------------------------------------------------

/** Reads every configured feed; also the scheduled refresh. */
export async function refresh(c: Context) {
  const s = (c.state = normalize(c.state));
  const incoming: Article[] = [], failed: string[] = [];
  for (const f of s.feeds!) {
    const at = new Date().toISOString();
    try {
      const rows = parseFeed(sourceBody(await c.callTool('web__fetch_page', { url: f.url })), f, at);
      if (!rows.length) throw new Error('Feed has no usable article URLs');
      incoming.push(...rows);
      s.receipts!.unshift({ source: f.name, url: f.url, at, rows: rows.length, status: 'Validated' });
    } catch (e) {
      const message = (e as Error).message.slice(0, 180);
      failed.push(`${f.name}: ${message}`);
      s.receipts!.unshift({ source: f.name, url: f.url, at, rows: 0, status: `Failed: ${message}` });
    }
  }
  const byId = new Map(s.articles!.map((a) => [a.id, a]));
  for (const row of incoming) byId.set(row.id, row);
  const newest = (a: Article, b: Article) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || b.retrievedAt.localeCompare(a.retrievedAt);
  const sorted = [...byId.values()].sort(newest);
  // Bookmarked articles outlive the recent window.
  s.articles = [...new Map([...sorted.filter((a) => s.saved!.includes(a.id)), ...sorted.slice(0, RECENT)].map((a) => [a.id, a])).values()].slice(0, MAX_ARTICLES).sort(newest);
  s.receipts = s.receipts!.slice(0, 24);
  s.checkedAt = new Date().toISOString();
  s.problem = failed.length ? `${failed.length} of ${s.feeds!.length} feeds failed; their earlier articles are kept. First: ${failed[0]}${failed.length === s.feeds!.length ? ` ${SETUP}` : ''}` : undefined;
  return { updates: view(s) };
}

// --- actions ---------------------------------------------------------------------

export async function handleAction(controlId: string, value: unknown, c: Context, action?: string) {
  const s = (c.state = normalize(c.state));
  const id = (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') ? (value as { id: string }).id : '';
  let focusSurface: string | undefined;
  if (!action) {
    const draft = /^\/newFeed\/(name|category|url)$/.exec(controlId);
    if (controlId === '/category') s.category = line(value, 40) || 'All';
    else if (draft) s.newFeed![draft[1] as keyof Feed] = line(value, draft[1] === 'url' ? 500 : 80);
    else throw new Error(`Unknown News Desk field: ${controlId}`);
  } else if (action === 'refresh') {
    return refresh(c);
  } else if (action === 'save_article') {
    if (!s.articles!.some((a) => a.id === id)) throw new Error('That article is no longer available');
    if (s.saved!.includes(id)) s.saved = s.saved!.filter((x) => x !== id);
    else { if (s.saved!.length >= MAX_SAVED) throw new Error(`The reading list keeps up to ${MAX_SAVED} articles; remove some first`); s.saved!.unshift(id); }
  } else if (action === 'add_feed') {
    if (s.feeds!.length >= MAX_FEEDS) throw new Error(`News Desk reads up to ${MAX_FEEDS} feeds; remove one first`);
    const f = feed(s.newFeed!);
    if (s.feeds!.some((x) => x.url === f.url)) throw new Error('That feed is already listed');
    s.feeds!.push(f);
    s.newFeed = { name: '', category: '', url: '' };
  } else if (action === 'remove_feed') {
    if (s.feeds!.length <= 1) throw new Error('Keep at least one feed');
    s.feeds = s.feeds!.filter((f) => f.url !== id);
  } else if (action === 'restore_feeds') {
    s.feeds = DEFAULT_FEEDS.map((f) => ({ ...f }));
  } else if (action === 'show_sources') {
    focusSurface = 'sources';
  } else {
    throw new Error(`Unknown News Desk action: ${action}`);
  }
  return { updates: view(s), ...(focusSurface ? { focusSurface } : {}) };
}

// --- derived views -----------------------------------------------------------------

const escape = (t: string) => t.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'Publication time unknown');
const replaceAll = (value: Record<string, unknown>) => [{ op: 'replace' as const, path: '/' as const, value }];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tally = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].map(([label, articles]) => ({ label, articles }));
const card = (s: State) => (a: Article) => ({
  id: a.id, title: a.title, meta: `${a.source} · ${a.category} · ${when(a.publishedAt)}`,
  body: `${a.excerpt ? `${escape(a.excerpt)}\n\n` : ''}[Read original](${a.url})`,
  saveLabel: s.saved!.includes(a.id) ? 'Remove from reading list' : 'Save for later', tone: s.saved!.includes(a.id) ? 'info' : 'neutral',
});

export function view(input: State): Update[] {
  const s = normalize(input);
  return [headlinesSurface(s), savedSurface(s), sourcesSurface(s)];
}

function headlinesSurface(s: State): Update {
  const all = s.articles!;
  const categories = [...new Set([...s.feeds!.map((f) => f.category), ...all.map((a) => a.category)])].sort();
  const category = categories.includes(s.category!) ? s.category! : 'All';
  const shown = all.filter((a) => category === 'All' || a.category === category);
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['news-bar', ...(s.problem ? ['news-problem'] : []), ...(all.length ? ['news-line', 'news-split'] : ['news-empty'])] },
    { id: 'news-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['category', 'refresh'] },
    { id: 'category', type: 'select', props: { label: 'Category', bind: '/category', options: '{/categoryOptions}' } },
    { id: 'refresh', type: 'button', props: { label: 'Refresh', action: 'refresh', style: 'primary' } },
    ...(s.problem ? [{ id: 'news-problem', type: 'alert', props: { title: 'Refresh incomplete', body: '{/problem}', tone: 'warning' } }] : []),
    ...(all.length ? [
      { id: 'news-line', type: 'text', props: { content: '{/line}', variant: 'caption' } },
      { id: 'news-split', type: 'split', props: { ratio: '2:1', gap: 'lg' }, children: [shown.length ? 'headlines' : 'news-none', 'coverage'] },
      { id: 'coverage', type: 'section', props: { title: 'Coverage', description: 'Across every saved headline, not only this category.' }, children: ['by-category', 'by-day', 'by-feed'] },
      { id: 'by-category', type: 'chart', props: { kind: 'pie', title: 'Articles by category', series: { records: '{/byCategory}', label: 'label', fields: ['articles'] }, height: 'sm' } },
      { id: 'by-day', type: 'chart', props: { kind: 'bar', title: 'Articles by publication day (UTC)', series: { records: '{/byDay}', label: 'label', fields: ['articles'] }, height: 'sm' } },
      { id: 'by-feed', type: 'chart', props: { kind: 'bar', orientation: 'horizontal', title: 'Articles by feed', series: { records: '{/byFeed}', label: 'label', fields: ['articles'] }, height: 'sm' } },
      ...(shown.length ? [
        { id: 'headlines', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'sm', searchable: true, pageSize: 12 }, children: { each: '/articles', template: 'article' } },
        { id: 'article', type: 'card', props: { title: '{title}', subtitle: '{meta}', body: '{body}', tone: '{tone}' }, children: ['article-save'] },
        { id: 'article-save', type: 'button', props: { label: '{saveLabel}', action: 'save_article', payload: { id: '{id}' }, style: 'link' } },
      ] : [{ id: 'news-none', type: 'text', props: { content: '{/none}', variant: 'caption' } }]),
    ] : [
      { id: 'news-empty', type: 'card', props: { title: 'No headlines yet', body: '{/emptyHint}' }, children: ['news-sources'] },
      { id: 'news-sources', type: 'button', props: { label: 'Review feeds', action: 'show_sources', style: 'link' } },
    ]),
  ];
  const data = {
    category, categoryOptions: [{ label: 'All categories', value: 'All' }, ...categories.map((value) => ({ label: value, value }))],
    ...(s.problem ? { problem: s.problem } : {}),
    ...(all.length ? {
      line: `${plural(shown.length, 'article')} from ${plural(new Set(shown.map((a) => a.source)).size, 'feed')}, newest first. Exact URLs are de-duplicated; the same event at different URLs is not merged.${s.checkedAt ? ` Checked ${when(s.checkedAt)}.` : ''}`,
      byCategory: tally(all.map((a) => a.category)), byFeed: tally(all.map((a) => a.source)).sort((a, b) => b.articles - a.articles),
      byDay: tally(all.flatMap((a) => (a.publishedAt ? [a.publishedAt.slice(0, 10)] : []))).sort((a, b) => a.label.localeCompare(b.label)).slice(-14),
      ...(shown.length ? { articles: shown.map(card(s)) } : { none: `No articles in ${category}. Choose another category or refresh.` }),
    } : { emptyHint: `${SETUP} Then press Refresh to read your ${plural(s.feeds!.length, 'feed')}; headlines appear here, newest first, with links to the originals.` }),
  };
  return { surface: 'headlines', nodes, data: replaceAll(data) };
}

function savedSurface(s: State): Update {
  const saved = s.saved!.map((id) => s.articles!.find((a) => a.id === id)!).filter(Boolean);
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: [saved.length ? 'saved-line' : 'saved-empty', ...(saved.length ? ['saved'] : [])] },
    ...(saved.length ? [
      { id: 'saved-line', type: 'text', props: { content: '{/line}', variant: 'caption' } },
      { id: 'saved', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'sm', searchable: true, pageSize: 12 }, children: { each: '/saved', template: 'saved-card' } },
      { id: 'saved-card', type: 'card', props: { title: '{title}', subtitle: '{meta}', body: '{body}' }, children: ['saved-remove'] },
      { id: 'saved-remove', type: 'button', props: { label: 'Remove', action: 'save_article', payload: { id: '{id}' }, style: 'link' } },
    ] : [{ id: 'saved-empty', type: 'text', props: { content: 'Articles you save from Headlines stay here, even after they leave the feed.', variant: 'caption' } }]),
  ];
  const data = saved.length ? { line: `${plural(saved.length, 'saved article')}. Excerpts are local bookmarks; open the original for the full report.`, saved: saved.map(card(s)) } : {};
  return { surface: 'saved', nodes, data: replaceAll(data) };
}

function sourcesSurface(s: State): Update {
  const receipts = s.receipts!;
  const custom = JSON.stringify(s.feeds) !== JSON.stringify(DEFAULT_FEEDS);
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['feeds-section', 'ledger-section'] },
    { id: 'feeds-section', type: 'section', props: { title: '{/feedsTitle}', description: 'Publisher RSS, Atom or JSON feeds over HTTPS. Names and categories are your labels.' }, children: ['feeds', ...(s.feeds!.length < MAX_FEEDS ? ['add-feed'] : []), ...(custom ? ['restore-feeds'] : [])] },
    { id: 'feeds', type: 'grid', props: { columns: 2, minItemWidth: 'md', gap: 'sm' }, children: { each: '/feeds', template: 'feed-card' } },
    { id: 'feed-card', type: 'card', props: { title: '{name}', subtitle: '{category}', body: '{url}' }, children: ['feed-remove'] },
    { id: 'feed-remove', type: 'button', props: { label: 'Remove', action: 'remove_feed', payload: { id: '{url}' }, style: 'link', visibleIf: '{removable}' } },
    ...(s.feeds!.length < MAX_FEEDS ? [
      { id: 'add-feed', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['feed-name', 'feed-category', 'feed-url', 'feed-add'] },
      { id: 'feed-name', type: 'input', props: { label: 'Name', bind: '/newFeed/name', placeholder: 'Publisher' } },
      { id: 'feed-category', type: 'input', props: { label: 'Category', bind: '/newFeed/category', placeholder: 'World' } },
      { id: 'feed-url', type: 'input', props: { label: 'Feed URL', bind: '/newFeed/url', placeholder: 'https://…/rss.xml' } },
      { id: 'feed-add', type: 'button', props: { label: 'Add feed', action: 'add_feed', style: 'secondary' } },
    ] : []),
    ...(custom ? [{ id: 'restore-feeds', type: 'button', props: { label: 'Restore the default feeds', action: 'restore_feeds', style: 'link' } }] : []),
    { id: 'ledger-section', type: 'section', props: { title: 'Source ledger', description: 'The latest 24 reads. A scheduled refresh (off until you enable it under Manage) runs every 15 minutes while the app and computer are awake.' }, children: [receipts.length ? 'receipts' : 'no-receipts'] },
    receipts.length
      ? { id: 'receipts', type: 'table', props: { rows: '{/receipts}', columns: [{ key: 'source', label: 'Feed' }, { key: 'at', label: 'Retrieved' }, { key: 'rows', label: 'Items', align: 'end' }, { key: 'status', label: 'Status' }], searchable: true, pageSize: 10 } }
      : { id: 'no-receipts', type: 'text', props: { content: `Nothing read yet. ${SETUP}`, variant: 'caption' } },
  ];
  const data = {
    feedsTitle: `Feeds · ${s.feeds!.length} of ${MAX_FEEDS}`,
    feeds: s.feeds!.map((f) => ({ ...f, removable: s.feeds!.length > 1 })),
    ...(s.feeds!.length < MAX_FEEDS ? { newFeed: s.newFeed } : {}),
    ...(receipts.length ? { receipts: receipts.map((r) => ({ ...r, at: when(r.at) })) } : {}),
  };
  return { surface: 'sources', nodes, data: replaceAll(data) };
}

/** The shipped surface.json: every view of a new, empty app. */
export const surfaceFile = () => view({}).map((u) => ({ id: u.surface, title: TITLES[u.surface], data: u.data[0]!.value, nodes: u.nodes }));
