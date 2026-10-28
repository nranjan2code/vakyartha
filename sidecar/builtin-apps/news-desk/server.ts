import { canonical, parseFeed, sourceBody, type Article } from './feed.ts';
interface Feed { name:string;category:string;url:string }
interface State {feeds?:string;category?:string;query?:string;articles?:Article[];saved?:string[];receipts?:Record<string,unknown>[];message?:string}
export interface Context {state:State;surfaces:Record<string,unknown>;callTool(name:string,args:Record<string,unknown>):Promise<unknown>}
const defaults:Feed[]=[{name:'BBC World',category:'World',url:'https://feeds.bbci.co.uk/news/world/rss.xml'},{name:'BBC Business',category:'Business',url:'https://feeds.bbci.co.uk/news/business/rss.xml'},{name:'BBC Technology',category:'Technology',url:'https://feeds.bbci.co.uk/news/technology/rss.xml'},{name:'BBC Science',category:'Science',url:'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'}];
export function feeds(text:string):Feed[]{const rows=JSON.parse(text);if(!Array.isArray(rows)||!rows.length||rows.length>6)throw Error('Configure 1–6 feeds');return rows.map(r=>{if(!r||typeof r.name!=='string'||!r.name.trim()||r.name.length>80||typeof r.category!=='string'||!r.category.trim()||r.category.length>40)throw Error('Every feed needs a short name and category');return {name:r.name.trim(),category:r.category.trim(),url:canonical(r.url)};});}
function init(s:State){s.feeds??=JSON.stringify(defaults,null,2);s.category??='All';s.query??='';s.articles??=[];s.saved??=[];s.receipts??=[];}
const escape=(s:string)=>s.replace(/[\\`*_{}\[\]<>]/g,'\\$&');
export function project(c:Context){init(c.state);const s=c.state;const selected=s.articles!.filter(a=>(s.category==='All'||a.category===s.category)&&`${a.title} ${a.excerpt} ${a.source}`.toLowerCase().includes(s.query!.toLowerCase()));
  const view=(rows:Article[])=>rows.map(a=>({...a,heading:a.title,body:`${escape(a.source)} · ${escape(a.category)} · ${a.publishedAt??'Publication time unknown'}\n\n${escape(a.excerpt)}\n\n[Read original](${a.url})`,savedLabel:s.saved!.includes(a.id)?'Remove from saved':'Save for later'}));
  const data={feeds:s.feeds,category:s.category,query:s.query,categoryOptions:[{label:'All categories',value:'All'},...[...new Set(s.articles!.map(a=>a.category))].sort().map(value=>({label:value,value}))],
    articles:view(selected),savedArticles:view(s.articles!.filter(a=>s.saved!.includes(a.id))),receipts:s.receipts,
    storyCount:String(selected.length),savedCount:String(s.saved!.length),sourceCount:String(new Set(s.articles!.map(a=>a.source)).size),
    message:s.message??'Connect Web pages and allow fetch_page, then refresh. No headlines have been retrieved yet.',
    basis:'Publisher feeds · newest known publication first · publication and retrieval times are separate · saved feed excerpts may be old',
    coverage:`${selected.length} matching articles from ${new Set(selected.map(a=>a.source)).size} sources. Exact canonical URLs are deduplicated; similar events across different URLs are not merged.`,
    empty:selected.length?'':'No matching articles. Refresh configured feeds or clear category/search filters.',
  };return {updates:Object.keys(c.surfaces).map(surface=>({surface,data}))};}
export async function refresh(c:Context){init(c.state);let successes=0;const incoming:Article[]=[];const config=feeds(c.state.feeds!);
  for(const f of config){const at=new Date().toISOString();try{const rows=parseFeed(sourceBody(await c.callTool('web__fetch_page',{url:f.url})),f,at);if(!rows.length)throw Error('Feed has no usable article URLs');incoming.push(...rows);successes++;c.state.receipts!.unshift({source:f.name,url:f.url,at,rows:rows.length,status:'Validated'});}catch(e){c.state.receipts!.unshift({source:f.name,url:f.url,at,rows:0,status:`Failed: ${(e as Error).message.slice(0,180)}`});}}
  const map=new Map(c.state.articles!.map(a=>[a.id,a]));for(const row of incoming)map.set(row.id,row);
  const sorted=[...map.values()].sort((a,b)=>(b.publishedAt??'').localeCompare(a.publishedAt??'')||b.retrievedAt.localeCompare(a.retrievedAt));
  const saved=sorted.filter(a=>c.state.saved!.includes(a.id));c.state.articles=[...new Map([...saved,...sorted.slice(0,180)].map(a=>[a.id,a])).values()].slice(0,240).sort((a,b)=>(b.publishedAt??'').localeCompare(a.publishedAt??''));
  c.state.receipts=c.state.receipts!.slice(0,24);c.state.message=`${successes}/${config.length} feeds refreshed. ${successes<config.length?'Failures retain prior articles with their original timestamps.':'Read originals for the complete reporting.'}`;return project(c);}
export async function handleAction(id:string,value:unknown,c:Context,action?:string){init(c.state);
  if(id==='/category'){c.state.category=String(value).slice(0,40);return project(c);}if(id==='/query'){c.state.query=String(value).slice(0,120);return project(c);}if(id==='/feeds'){if(String(value).length>6000)throw Error('Feed configuration too large');c.state.feeds=String(value);return project(c);}
  if(action==='refresh'||id==='refresh')return refresh(c);
  if(action==='apply_filters')return project(c);
  if(action==='save_article'){const articleId=String((value as any)?.id??'');if(!c.state.articles!.some(a=>a.id===articleId))throw Error('Article is no longer available');const saved=new Set(c.state.saved);if(saved.has(articleId))saved.delete(articleId);else{if(saved.size>=60)throw Error('Saved list is limited to 60 articles');saved.add(articleId);}c.state.saved=[...saved];return project(c);}
  throw Error('Unknown news action');}
