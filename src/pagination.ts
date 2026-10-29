import { el } from './core.ts';
import { icon } from './icons.ts';
import { CollectionPage } from '../shared/pagination.ts';
export { CollectionPage };
export function pageControls(page: CollectionPage, total: number, label: string, render: () => void): HTMLElement {
  const nav = el('nav', { className: 'collection-pages', 'aria-label': `${label} pages`, hidden: total <= 12 });
  const change = (kind: string, action: () => void) => {
    action(); render();
    queueMicrotask(() => {
      const next = [...document.querySelectorAll<HTMLElement>('.collection-pages')].find(n => n.getAttribute('aria-label') === `${label} pages` && !n.hidden);
      const target = next?.querySelector<HTMLButtonElement | HTMLSelectElement>(`[data-page-control="${kind}"]`);
      (target && !target.disabled ? target : next?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    });
  };
  const sizes = el('select', { 'aria-label': `${label} per page`, 'data-page-control': 'size' });
  for (const n of [12, 24, 48]) sizes.append(el('option', { value: String(n), textContent: String(n) }));
  sizes.value = String(page.size); sizes.onchange = () => change('size', () => page.resize(Number(sizes.value)));
  nav.append(el('span', { role: 'status', textContent: total ? `${page.index * page.size + 1}–${Math.min(total, (page.index + 1) * page.size)} of ${total}` : '0 items' }),
    el('label', {}, document.createTextNode('Per page '), sizes),
    el('button', { type: 'button', className: 'icon-action', title: 'Previous page', 'aria-label': 'Previous page', 'data-page-control': 'previous', disabled: page.index === 0, onclick: () => change('previous', () => { page.index--; }) }, icon('chevron-left', 14)),
    el('span', { textContent: `${page.index + 1} / ${Math.max(1, Math.ceil(total / page.size))}` }),
    el('button', { type: 'button', className: 'icon-action', title: 'Next page', 'aria-label': 'Next page', 'data-page-control': 'next', disabled: (page.index + 1) * page.size >= total, onclick: () => change('next', () => { page.index++; }) }, icon('arrow', 14)));
  return nav;
}

/** Keep the same item nodes when browsing so local drafts/expanded details survive. */
export function pagedNodes(nodes: HTMLElement[], label: string, searchable = false): HTMLElement {
  const page = new CollectionPage(), body = el('div'), controls = el('div'), root = el('div', { className: 'paged-collection' });
  const search = el('input', { type: 'search', className: 'market-search', placeholder: `Search ${label.toLowerCase()}…`, 'aria-label': `Search ${label.toLowerCase()}` });
  const paint = () => {
    const query = search.value.toLowerCase().trim();
    const matches = nodes.filter(node => (node.textContent ?? '').toLowerCase().includes(query));
    body.replaceChildren(...page.slice(matches, query));
    if (!matches.length) body.append(el('p', { className: 'row-hint', textContent: 'No matches.' }));
    controls.replaceChildren(pageControls(page, matches.length, label, paint));
  };
  search.oninput = paint;
  if (searchable && nodes.length > 12) root.append(search);
  root.append(body, controls); paint(); return root;
}
