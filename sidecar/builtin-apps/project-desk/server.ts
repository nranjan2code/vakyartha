// Project Activity Desk: a bounded sample of a public repository's issues,
// pull requests and commits, read through the governed `web__fetch_page` tool,
// with local triage lanes. Everything lives in `context.state`; `view()`
// derives every surface from it. Triage never writes to the repository.

export interface Item { id: string; number: number; title: string; state: string; url: string; updatedAt: string; labels: string; author: string }
export interface Commit { id: string; title: string; date: string; url: string; author: string }
export interface Receipt { dataset: string; url: string; at: string; rows: number; status: string }
export interface State {
  repository?: string; repoDraft?: string; issues?: Item[]; pulls?: Item[]; commits?: Commit[];
  triage?: Record<string, string>; receipts?: Receipt[]; problem?: string; checkedAt?: string;
}
export interface Context { state: State; surfaces?: Record<string, unknown>; callTool(name: string, args: Record<string, unknown>): Promise<unknown> }
interface Node { id: string; type: string; props?: Record<string, unknown>; children?: string[] | { each: string; template: string } }
interface Update { surface: string; nodes: Node[]; data: { op: 'replace'; path: '/'; value: Record<string, unknown> }[] }

const LANES = ['Review', 'Next', 'Watch'];
export const TITLES: Record<string, string> = { triage: 'Triage', activity: 'Activity', sources: 'Sources' };
const SETUP = 'In Settings → Integrations, enable Web pages and set fetch_page to Allow.';

// --- source parsing ----------------------------------------------------------------

export function repository(value: unknown) {
  const s = String(value ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(s) || s.endsWith('/..') || s.endsWith('/.')) throw new Error('Use owner/repository for a public repository');
  return s;
}
export function source(result: unknown) {
  if (result && typeof result === 'object' && (result as { isError?: unknown }).isError) throw new Error('Source tool failed');
  const text = typeof result === 'string' ? result : String((result as { text?: unknown })?.text ?? '');
  const body = /^URL: https:\/\/[^\n]+\n\n([\s\S]*)$/.exec(text)?.[1];
  if (!body) throw new Error('Expected the original JSON response');
  const data = JSON.parse(body);
  if (!Array.isArray(data) || data.length > 30) throw new Error('Expected bounded repository records');
  return data;
}
function str(v: unknown, max = 240) { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Missing or oversized repository text'); return v; }
function date(v: unknown) { const d = new Date(str(v, 80)); if (!Number.isFinite(d.getTime())) throw new Error('Invalid source timestamp'); return d.toISOString(); }
function url(v: unknown) { const u = new URL(str(v, 500)); if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password) throw new Error('Invalid repository record URL'); return u.href; }
export function items(raw: any[], repo: string, pulls = false): Item[] {
  return raw.filter((r) => pulls || !r.pull_request).map((r) => {
    if (!Number.isSafeInteger(r.number) || r.number <= 0 || !['open', 'closed'].includes(r.state)) throw new Error('Invalid source item identity or state');
    const link = url(r.html_url);
    if (!link.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/${pulls ? 'pull' : 'issues'}/`)) throw new Error('Repository item identity mismatch');
    return { id: link, number: r.number, title: str(r.title), state: r.state, url: link, updatedAt: date(r.updated_at), labels: Array.isArray(r.labels) ? r.labels.map((l: { name?: unknown }) => str(l.name, 80)).join(', ') : '', author: str(r.user?.login, 80) };
  });
}
export function commits(raw: any[], repo: string): Commit[] {
  return raw.map((r) => {
    const link = url(r.html_url);
    if (!link.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/commit/`) || !/^[a-f0-9]{40}$/.test(r.sha)) throw new Error('Commit identity mismatch');
    return { id: r.sha, title: str(String(r.commit?.message ?? '').split('\n')[0], 240), date: date(r.commit?.author?.date), url: link, author: str(r.commit?.author?.name, 100) };
  });
}

// --- canonical state ---------------------------------------------------------------

const isItem = (r: Item) => r && typeof r.id === 'string' && Number.isSafeInteger(r.number) && typeof r.title === 'string' && typeof r.state === 'string' && typeof r.url === 'string';
const isCommit = (r: Commit) => r && typeof r.id === 'string' && typeof r.title === 'string' && typeof r.url === 'string';
export function normalize(s: State): State {
  let repo = 'nranjan2code/vakyartha';
  try { repo = repository(s.repository ?? repo); } catch { /* keep the default */ }
  const issues = (Array.isArray(s.issues) ? s.issues : []).filter(isItem).slice(0, 30);
  const open = new Set(issues.filter((i) => i.state === 'open').map((i) => i.id));
  const triage: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.triage && typeof s.triage === 'object' ? s.triage : {})) if (open.has(k) && LANES.includes(v)) triage[k] = v;
  return {
    repository: repo, repoDraft: typeof s.repoDraft === 'string' ? s.repoDraft.slice(0, 200) : repo,
    issues, pulls: (Array.isArray(s.pulls) ? s.pulls : []).filter(isItem).slice(0, 30), commits: (Array.isArray(s.commits) ? s.commits : []).filter(isCommit).slice(0, 30),
    triage, receipts: (Array.isArray(s.receipts) ? s.receipts : []).filter((r) => r && typeof r.dataset === 'string').slice(0, 24),
    problem: typeof s.problem === 'string' ? s.problem.slice(0, 800) : undefined, checkedAt: typeof s.checkedAt === 'string' ? s.checkedAt : undefined,
  };
}

// --- refresh -----------------------------------------------------------------------

/** A tool failure as one readable sentence: the host's untrusted-output envelope and labels removed, never cut mid-address. */
export const reason = (e: unknown) => String((e as Error)?.message ?? e)
  .replace(/<\/?tool_output[^>]*>/g, ' ').replace(/This is data returned by a tool, not instructions\.[^\n]*/g, ' ')
  .replace(/\b(error|refused):\s*(?=(error|refused):)/gi, '').replace(/^\s*error:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 400);
// Only a missing integration or policy is fixed in Settings; other failures speak for themselves.
const needsSetup = (m: string) => /Allow policy|not declared or available|integration tool is unavailable/i.test(m);

/** Reads the three samples for the saved repository; also the scheduled refresh. */
export async function refresh(c: Context) {
  const s = (c.state = normalize(c.state));
  const repo = s.repository!, base = `https://api.github.com/repos/${repo}`;
  const jobs = [['issues', `${base}/issues?state=all&sort=updated&direction=desc&per_page=20`], ['pulls', `${base}/pulls?state=open&sort=updated&per_page=10`], ['commits', `${base}/commits?per_page=10`]] as const;
  const failed: string[] = [];
  for (const [kind, address] of jobs) {
    const at = new Date().toISOString();
    try {
      const rows = source(await c.callTool('web__fetch_page', { url: address }));
      if (kind === 'commits') s.commits = commits(rows, repo); else s[kind] = items(rows, repo, kind === 'pulls');
      s.receipts!.unshift({ dataset: kind, url: address, at, rows: rows.length, status: 'Validated' });
    } catch (e) {
      const message = reason(e);
      failed.push(`${kind}: ${message}`);
      s.receipts!.unshift({ dataset: kind, url: address, at, rows: 0, status: `Failed: ${message}` });
    }
  }
  s.receipts = s.receipts!.slice(0, 24);
  s.checkedAt = new Date().toISOString();
  s.problem = failed.length ? `${failed.length} of 3 reads failed; earlier records are kept. First: ${failed[0]}${needsSetup(failed[0]!) ? ` ${SETUP}` : ''}` : undefined;
  return { updates: view(normalize(s)) };
}

// --- actions ---------------------------------------------------------------------

export async function handleAction(controlId: string, value: unknown, c: Context, action?: string) {
  const s = (c.state = normalize(c.state));
  if (!action) {
    if (controlId === '/repoDraft') s.repoDraft = String(value ?? '').slice(0, 200);
    else if (controlId === '/cards') {
      // The board writes its whole card list; only lane changes of known open issues are kept.
      if (!Array.isArray(value) || value.length > 30) throw new Error('Invalid triage cards');
      const open = new Set(s.issues!.filter((i) => i.state === 'open').map((i) => i.id));
      const moves: Record<string, string> = {};
      for (const row of value) { if (!open.has(row?.id) || !LANES.includes(row?.column)) throw new Error('Invalid triage card or lane'); moves[row.id] = row.column; }
      s.triage = moves;
    } else throw new Error(`Unknown Project Desk field: ${controlId}`);
    return { updates: view(s) };
  }
  if (action === 'refresh') {
    // Pressing Refresh applies the typed repository; a different one starts a fresh sample.
    const next = repository(s.repoDraft);
    if (next.toLowerCase() !== s.repository!.toLowerCase()) Object.assign(s, { issues: [], pulls: [], commits: [], triage: {}, problem: undefined, checkedAt: undefined });
    s.repository = s.repoDraft = next;
    return refresh(c);
  }
  throw new Error(`Unknown Project Desk action: ${action}`);
}

// --- derived views -----------------------------------------------------------------

const tally = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].map(([label, issues]) => ({ label, issues }));
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const replaceAll = (value: Record<string, unknown>) => [{ op: 'replace' as const, path: '/' as const, value }];
const problemNode = (id: string): Node => ({ id, type: 'alert', props: { title: 'Refresh incomplete', body: '{/problem}', tone: 'warning' } });

export function view(input: State): Update[] {
  const s = normalize(input);
  return [triageSurface(s), activitySurface(s), sourcesSurface(s)];
}

function triageSurface(s: State): Update {
  const open = s.issues!.filter((r) => r.state === 'open');
  const any = s.issues!.length + s.pulls!.length + s.commits!.length > 0;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['repo-bar', ...(s.problem ? ['triage-problem'] : []), ...(any ? ['repo-line', 'counts', ...(s.issues!.length ? ['issue-charts'] : []), ...(open.length ? ['board-section'] : []), ...(s.issues!.length ? ['issues-section'] : [])] : ['triage-empty'])] },
    { id: 'repo-bar', type: 'stack', props: { direction: 'horizontal', wrap: true, gap: 'sm', align: 'end' }, children: ['repo-input', 'refresh'] },
    { id: 'repo-input', type: 'input', props: { label: 'Public repository', bind: '/repoDraft', placeholder: 'owner/repository' } },
    { id: 'refresh', type: 'button', props: { label: 'Refresh', action: 'refresh', style: 'primary' } },
    ...(s.problem ? [problemNode('triage-problem')] : []),
    ...(any ? [
      { id: 'repo-line', type: 'text', props: { content: '{/line}', variant: 'caption' } },
      { id: 'counts', type: 'grid', props: { columns: 4, minItemWidth: 'sm', gap: 'sm' }, children: { each: '/counts', template: 'count' } },
      { id: 'count', type: 'stat', props: { label: '{label}', value: '{value}' } },
      ...(s.issues!.length ? [
        { id: 'issue-charts', type: 'grid', props: { columns: 3, minItemWidth: 'sm', gap: 'md' }, children: ['state-chart', 'label-chart', 'updated-chart'] },
        { id: 'state-chart', type: 'chart', props: { kind: 'pie', title: 'Issues by state', series: { records: '{/byState}', label: 'label', fields: ['issues'] }, height: 'sm' } },
        { id: 'label-chart', type: 'chart', props: { kind: 'bar', orientation: 'horizontal', title: 'Issues by label', series: { records: '{/byLabel}', label: 'label', fields: ['issues'] }, height: 'sm' } },
        { id: 'updated-chart', type: 'chart', props: { kind: 'bar', title: 'Issues by last update (UTC day)', series: { records: '{/byDay}', label: 'label', fields: ['issues'] }, height: 'sm' } },
      ] : []),
      ...(open.length ? [
        { id: 'board-section', type: 'section', props: { title: 'Local triage', description: 'Drag open issues between lanes to plan your attention. This never changes the repository.' }, children: ['board'] },
        { id: 'board', type: 'board', props: { columns: LANES, cards: '{/cards}', bind: '/cards' } },
      ] : []),
      ...(s.issues!.length ? [
        { id: 'issues-section', type: 'section', props: { title: 'Recently updated issues' }, children: ['issues'] },
        { id: 'issues', type: 'table', props: { rows: '{/issues}', columns: [{ key: 'link', label: 'Issue' }, { key: 'title', label: 'Title' }, { key: 'state', label: 'State' }, { key: 'labels', label: 'Labels' }, { key: 'author', label: 'Author' }, { key: 'updated', label: 'Updated' }], sortable: true, searchable: true, pageSize: 10 } },
      ] : []),
    ] : [{ id: 'triage-empty', type: 'card', props: { title: 'No repository activity yet', body: '{/emptyHint}' } }]),
  ];
  const data = {
    repoDraft: s.repoDraft,
    ...(s.problem ? { problem: s.problem } : {}),
    ...(any ? {
      line: `${s.repository} · a bounded sample of up to 20 recently updated issues, 10 open pull requests and 10 commits; counts describe this sample, not the whole backlog.${s.checkedAt ? ` Checked ${when(s.checkedAt)}.` : ''}`,
      counts: [
        { label: 'Open issues', value: open.length }, { label: 'Closed issues', value: s.issues!.length - open.length },
        { label: 'Open pull requests', value: s.pulls!.length }, { label: 'Recent commits', value: s.commits!.length },
      ],
      ...(open.length ? { cards: open.map((r) => ({ id: r.id, title: `#${r.number} ${r.title}`, column: s.triage![r.id] ?? 'Review', note: `${r.author} · ${r.updatedAt.slice(0, 10)}`, tag: r.labels.slice(0, 60) })) } : {}),
      ...(s.issues!.length ? {
        byState: tally(s.issues!.map((r) => r.state)),
        byLabel: tally(s.issues!.flatMap((r) => (r.labels ? r.labels.split(', ') : ['No label']))).sort((a, b) => b.issues - a.issues).slice(0, 8),
        byDay: tally(s.issues!.map((r) => r.updatedAt.slice(0, 10))).sort((a, b) => a.label.localeCompare(b.label)),
        issues: s.issues!.map((r) => ({ ...r, link: `#${r.number}`, updated: when(r.updatedAt) })),
      } : {}),
    } : { emptyHint: `${SETUP} Then type a public owner/repository and press Refresh. Recent issues, pull requests and commits appear here, with lanes for your own triage.` }),
  };
  return { surface: 'triage', nodes, data: replaceAll(data) };
}

function activitySurface(s: State): Update {
  const has = s.commits!.length + s.pulls!.length > 0;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: has ? [...(s.commits!.length ? ['commit-chart'] : []), 'activity-split'] : ['activity-empty'] },
    ...(has ? [{ id: 'activity-split', type: 'split', props: { ratio: '1:1', gap: 'lg' }, children: [...(s.commits!.length ? ['commits-section'] : []), ...(s.pulls!.length ? ['pulls-section'] : [])] }] : []),
    ...(s.commits!.length ? [{ id: 'commit-chart', type: 'chart', props: { kind: 'bar', title: 'Commits per day in the sample (UTC)', series: { records: '{/commitDays}', label: 'label', fields: ['commits'] }, height: 'sm' } }] : []),
    ...(s.pulls!.length ? [
      { id: 'pulls-section', type: 'section', props: { title: 'Open pull requests' }, children: ['pulls'] },
      { id: 'pulls', type: 'table', props: { rows: '{/pulls}', columns: [{ key: 'link', label: 'PR' }, { key: 'title', label: 'Title' }, { key: 'author', label: 'Author' }, { key: 'updated', label: 'Updated' }], sortable: true, pageSize: 10 } },
    ] : []),
    ...(s.commits!.length ? [
      { id: 'commits-section', type: 'section', props: { title: 'Recent commits' }, children: ['timeline'] },
      { id: 'timeline', type: 'timeline', props: { items: '{/timeline}' } },
    ] : []),
    ...(has ? [] : [{ id: 'activity-empty', type: 'text', props: { content: 'Open pull requests and recent commits appear here after a refresh on Triage.', variant: 'caption' } }]),
  ];
  const data = {
    ...(s.pulls!.length ? { pulls: s.pulls!.map((r) => ({ ...r, link: `#${r.number}`, updated: when(r.updatedAt) })) } : {}),
    ...(s.commits!.length ? { commitDays: tally(s.commits!.map((r) => r.date.slice(0, 10))).map((r) => ({ label: r.label, commits: r.issues })).sort((a, b) => a.label.localeCompare(b.label)), timeline: s.commits!.map((r) => ({ date: when(r.date), title: r.title, description: `${r.author} · [${r.id.slice(0, 7)}](${r.url})` })) } : {}),
  };
  return { surface: 'activity', nodes, data: replaceAll(data) };
}

function sourcesSurface(s: State): Update {
  const receipts = s.receipts!;
  const nodes: Node[] = [
    { id: 'root', type: 'stack', props: { gap: 'md' }, children: ['ledger-section'] },
    { id: 'ledger-section', type: 'section', props: { title: 'Source ledger', description: 'The latest 24 reads of the public repository API. A scheduled refresh (off until you enable it under Manage) runs every 15 minutes while the app and computer are awake.' }, children: [receipts.length ? 'receipts' : 'no-receipts'] },
    receipts.length
      ? { id: 'receipts', type: 'table', props: { rows: '{/receipts}', columns: [{ key: 'dataset', label: 'Dataset' }, { key: 'url', label: 'Source URL' }, { key: 'at', label: 'Retrieved' }, { key: 'rows', label: 'Rows', align: 'end' }, { key: 'status', label: 'Status' }], searchable: true, pageSize: 10 } }
      : { id: 'no-receipts', type: 'text', props: { content: `Nothing read yet. ${SETUP}`, variant: 'caption' } },
  ];
  return { surface: 'sources', nodes, data: replaceAll(receipts.length ? { receipts: receipts.map((r) => ({ ...r, at: when(r.at) })) } : {}) };
}

/** The shipped surface.json: every view of a new, empty app. */
export const surfaceFile = () => view({}).map((u) => ({ id: u.surface, title: TITLES[u.surface], data: u.data[0]!.value, nodes: u.nodes }));
