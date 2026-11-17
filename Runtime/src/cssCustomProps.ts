/** CSS custom properties (--name) through getComputedStyle(el).getPropertyValue('--name'), as a browser computes them:
 *  inherited from the nearest ancestor that sets one, in its style attribute or by a stylesheet rule that matches it.
 *  The runtime's getComputedStyle read only the element's own style attribute, so a variable the page sets on <html>
 *  (a measured bar height, a theme token) read as "" from every element below it.
 *  Rules come from the page's stylesheet (the build's CSS file, read once through the host) and the <style> elements
 *  the page adds at run time. The cascade is approximated: the rule with the highest specificity wins, then the later
 *  one; @media blocks count when their query matches now. */
import {host} from './host';
import {domPage} from './dom';
import {matchesMedia} from './mediaQueries';

const g = globalThis as Record<string, any>;
type N = Record<string, any>;
type Rule = {selectors: string[]; media: string[]; value: string; order: number};
const doc = domPage.document as N;

/** Strips comments and splits a stylesheet into the custom-property declarations of each style rule. */
export function parseCustomProps(css: string, into = new Map<string, Rule[]>(), start = 0): Map<string, Rule[]> {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack: {kind: 'media' | 'rule' | 'skip' | 'group'; text: string}[] = [];
  let from = 0, order = start;
  // Walks from one brace to the next; quoted strings are skipped whole.
  for (let i = 0; i < css.length; i++) {
    const c = css.charCodeAt(i);
    if (c === 34 || c === 39) { const q = css[i]; for (i++; i < css.length && css[i] !== q; i++) if (css[i] === '\\') i++; continue; }
    if (c !== 123 && c !== 125) continue;
    const buf = css.slice(from, i);
    from = i + 1;
    if (c === 123) {
      const head = buf.trim();
      const inSkip = stack.some(s => s.kind === 'skip' || s.kind === 'rule');
      const kind = inSkip ? 'skip' : /^@media\b/i.test(head) ? 'media' : /^@(supports|layer|container|scope|document)\b/i.test(head) ? 'group' : head.startsWith('@') ? 'skip' : 'rule';
      stack.push({kind, text: kind === 'media' ? head.replace(/^@media\s*/i, '') : head});
      continue;
    }
    const top = stack.pop();
    if (top?.kind !== 'rule' || !buf.includes('--')) continue;
    const media = stack.filter(s => s.kind === 'media').map(s => s.text);
    for (const decl of buf.split(';')) {
      const m = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(decl);
      if (!m) continue;
      const list = into.get(m[1]) ?? [];
      // A value written over several lines reads as one, so it can go straight into a font or a color.
      const value = m[2].replace(/!important\s*$/i, '').replace(/[ \t]*[\r\n]\s*/g, ' ').trim();
      list.push({selectors: splitSelectors(top.text), media, value, order: order++});
      into.set(m[1], list);
    }
  }
  return into;
}
function splitSelectors(text: string): string[] {
  const out: string[] = []; let depth = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--; else if (c === ',' && !depth) { out.push(text.slice(last, i).trim()); last = i + 1; }
  }
  out.push(text.slice(last).trim());
  return out.filter(Boolean);
}
/** Specificity as one number: ids, then classes, attributes and pseudo-classes, then type selectors. */
export function specificity(sel: string): number {
  const s = sel.replace(/\[[^\]]*\]/g, ' .a ').replace(/::[\w-]+/g, ' t ').replace(/:(where)\([^)]*\)/g, '').replace(/:(not|is|has)\(/g, ' (');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|:[\w-]+/g) ?? []).length;
  const types = (s.replace(/[#.:][\w-]+/g, ' ').match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 1e6 + classes * 1e3 + types;
}

let pageRules: Map<string, Rule[]> | null = null;
let headRules = new Map<string, Rule[]>(), headText = '';
const PAGE_ORDER = 0, HEAD_ORDER = 1e7;
function pageCss(): string {
  try {
    const text = (path: string) => { const b = host.readFile(path); return b ? new g.TextDecoder().decode(b) as string : null; };
    const name = (JSON.parse(text('/page.json') ?? '{}') as {css?: string}).css;
    return name ? text('/' + name.replace(/^\/+/, '')) ?? '' : '';
  } catch { return ''; }
}
function rulesFor(name: string): Rule[] {
  pageRules ??= parseCustomProps(pageCss(), new Map(), PAGE_ORDER);
  const now = [...(doc.head?.querySelectorAll('style') ?? [])].map((s: N) => s.textContent ?? '').join('\n');
  if (now !== headText) { headText = now; headRules = parseCustomProps(now, new Map(), HEAD_ORDER); }
  return [...(pageRules.get(name) ?? []), ...(headRules.get(name) ?? [])];
}

const matches = (el: N, sel: string) => { try { return !!el.matches?.(sel); } catch { return false; } };
/** The declared value of `name` on `el` itself, from its style attribute or the winning rule; "" when none. */
function declaredOn(el: N, name: string, rules: Rule[]): string {
  const inline = el.style?.getPropertyValue?.(name);
  if (inline) return String(inline).trim();
  let best: Rule | null = null, bestSpec = -1;
  for (const r of rules) {
    if (r.media.length && !r.media.every(m => matchesMedia(m))) continue;
    let spec = -1;
    for (const sel of r.selectors) if (matches(el, sel)) spec = Math.max(spec, specificity(sel));
    if (spec < 0) continue;
    if (spec > bestSpec || (spec === bestSpec && best && r.order > best.order)) { best = r; bestSpec = spec; }
  }
  return best?.value ?? '';
}

/** The computed value of custom property `name` for `el`, with var() references in it resolved; "" when unset. */
export function customProperty(el: N, name: string, depth = 0): string {
  if (depth > 8) return '';
  const rules = rulesFor(name);
  for (let n: N | null = el; n && n.nodeType === 1; n = n.parentNode) {
    const v = declaredOn(n, name, rules);
    if (v) return resolveVars(v, n, depth);
  }
  return '';
}
function resolveVars(value: string, el: N, depth: number): string {
  if (!value.includes('var(')) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, ref: string, fallback?: string) =>
    customProperty(el, ref, depth + 1) || (fallback !== undefined ? resolveVars(fallback.trim(), el, depth + 1) : ''));
}

let installed = false;
export function installCustomProps() {
  if (installed || typeof g.getComputedStyle !== 'function') return;
  installed = true;
  const base = g.getComputedStyle as (el: N, pseudo?: string) => N;
  g.getComputedStyle = (el: N, pseudo?: string) => {
    const cs = base(el, pseudo);
    if (!el || typeof el !== 'object' || el.nodeType !== 1) return cs;
    return new Proxy(cs, {get(t: N, k: string | symbol) {
      if (k === 'getPropertyValue') return (p: string) => {
        const name = String(p), own = t.getPropertyValue(name);
        return own || !name.startsWith('--') ? own : customProperty(el, name);
      };
      return t[k as string];
    }});
  };
}
installCustomProps();
