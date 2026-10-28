import './reference-apps.css';
import { el } from './core.ts';
import type { AppManifest } from '../shared/app-manifest.ts';

/** Both app entry points discover the shipped packages rather than maintaining
 * competing hard-coded lists of which examples happen to exist. */
export function chooseReferenceApp(entries: AppManifest[], installed: string[]): Promise<string | null> {
  return new Promise(resolve => {
    const available=entries.filter(e=>!installed.includes(e.id));
    const dialog=el('dialog',{className:'reference-app-dialog','aria-label':'Install reference application'});
    const select=el('select',{'aria-label':'Reference application'});
    for(const entry of available)select.append(el('option',{value:entry.id,textContent:entry.name}));
    const description=el('p',{className:'muted'});
    const update=()=>{description.textContent=available.find(e=>e.id===select.value)?.description??'All bundled references are already installed.';};
    select.onchange=update;update();
    const close=(id:string|null)=>{dialog.close();dialog.remove();resolve(id);};
    const install=el('button',{type:'button',textContent:'Install reference',disabled:!available.length,onclick:()=>close(select.value||null)});
    dialog.append(el('h2',{textContent:'Reference applications'}),el('p',{textContent:'Complete source packages with in-app documentation. Installation leaves schedules off and grants no integration permissions.'}),select,description,el('div',{className:'reference-app-actions'},el('button',{type:'button',className:'ghost',textContent:'Cancel',onclick:()=>close(null)}),install));
    dialog.addEventListener('cancel',e=>{e.preventDefault();close(null);});document.body.append(dialog);dialog.showModal();
  });
}
