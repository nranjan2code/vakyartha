// A bounded syndication subset, not an HTML/XML browser: reject DTD/entity
// declarations and malformed nesting. No source markup becomes executable UI.
export interface Article { id: string; title: string; url: string; source: string; category: string; publishedAt: string | null; retrievedAt: string; excerpt: string }
interface Element { name: string; attrs: Record<string,string>; text: string; children: Element[] }
const entities = (s:string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,key:string)=>{
  const names:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(!key.startsWith('#'))return names[key.toLowerCase()]!;
  const n=key.toLowerCase().startsWith('#x')?parseInt(key.slice(2),16):Number(key.slice(1));
  if(!Number.isInteger(n)||n<=0||n>0x10ffff||n>=0xd800&&n<=0xdfff)throw Error('Invalid feed entity');return String.fromCodePoint(n);
});
export const plain=(s:string)=>entities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function canonical(raw:string,base?:string):string {
  const u=new URL(raw,base);if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('Expected a credential-free HTTPS article/feed URL');
  for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k))u.searchParams.delete(k);u.hash='';return u.href;
}
function xml(source:string):Element {
  if(source.length>240000||/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('Unsupported or oversized feed XML');
  const root:Element={name:'root',attrs:{},text:'',children:[]}, stack=[root];
  const tokens=source.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g)??[];
  if(tokens.join('')!==source||tokens.length>20000)throw Error('Malformed or oversized feed tokens');
  for(const token of tokens){
    const top=stack.at(-1)!;
    if(token.startsWith('<!--')||token.startsWith('<?'))continue;
    if(token.startsWith('<![CDATA[')){top.text+=token.slice(9,-3);continue;}
    if(token.startsWith('</')){const name=/^<\/([\w:.-]+)\s*>$/.exec(token)?.[1];if(stack.length<2||top.name!==name)throw Error('Mismatched feed XML');stack.pop();continue;}
    if(token.startsWith('<')){
      const m=/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/.exec(token);if(!m||stack.length>24)throw Error('Unsupported feed XML');
      const attrs:Record<string,string>={};for(const a of m[2]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[a[1]!]=entities(a[2]??a[3]??'');
      const el:Element={name:m[1]!,attrs,text:'',children:[]};top.children.push(el);if(!m[3])stack.push(el);continue;
    }
    top.text+=entities(token);
  }
  if(stack.length!==1||root.children.length!==1)throw Error('Incomplete feed XML');return root.children[0]!;
}
const local=(e:Element)=>e.name.split(':').at(-1)!;
const child=(e:Element,name:string)=>e.children.find(c=>local(c)===name);
const date=(value:unknown)=>{if(typeof value!=='string'||!value.trim())return null;const d=new Date(value);return Number.isFinite(d.getTime())?d.toISOString():null;};
export function parseFeed(body:string,feed:{name:string;category:string;url:string},retrievedAt:string):Article[]{
  let rows:{title:string;url:string;publishedAt:string|null;excerpt:string}[];
  if(body.trimStart().startsWith('{')){
    const data=JSON.parse(body);if(!/^https:\/\/jsonfeed.org\/version\/1(?:\.1)?$/.test(data.version)||!Array.isArray(data.items)||data.items.length>500)throw Error('Unsupported JSON Feed');
    rows=data.items.map((r:any)=>({title:plain(String(r.title??'Untitled article')),url:canonical(String(r.url??r.external_url??''),feed.url),publishedAt:date(r.date_published),excerpt:plain(String(r.summary??r.content_text??r.content_html??''))}));
  }else{
    const root=xml(body), atom=local(root)==='feed', channel=atom?root:child(root,'channel');
    if(!channel||!atom&&local(root)!=='rss')throw Error('Expected RSS or Atom');
    rows=channel.children.filter(c=>local(c)===(atom?'entry':'item')).map(r=>{
      const link=atom?r.children.find(c=>local(c)==='link'&&(!c.attrs.rel||c.attrs.rel==='alternate'))?.attrs.href:child(r,'link')?.text;
      return {title:plain(child(r,'title')?.text??'Untitled article'),url:canonical(link??'',feed.url),publishedAt:date(child(r,atom?'published':'pubDate')?.text??child(r,'updated')?.text),excerpt:plain(child(r,atom?'summary':'description')?.text??'')};
    });
  }
  const seen=new Set<string>();return rows.slice(0,60).filter(r=>{if(!r.title||r.url===feed.url||seen.has(r.url))return false;seen.add(r.url);return true;}).map(r=>({...r,id:r.url,title:r.title.slice(0,240),excerpt:r.excerpt.slice(0,200),source:feed.name,category:feed.category,retrievedAt}));
}
export function sourceBody(result:unknown):string {
  if(result&&typeof result==='object'&&(result as any).isError)throw Error('Source tool failed');
  const text=typeof result==='string'?result:String((result as any)?.text??'');
  const match=/^URL: (https:\/\/[^\n]+)\n\n([\s\S]*)$/.exec(text);if(!match)throw Error('Expected original feed response, not a rendered HTML page');
  if(match[2]!.length>240000)throw Error('Feed exceeds app response bound');return match[2]!;
}
