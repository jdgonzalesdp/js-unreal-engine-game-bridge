// Blanks out comments and the text inside string, template and regular expression literals, keeping every offset and
// line break, so a source pattern (new URL(...), import.meta.glob(...)) is only found where it is code. Vite does the
// same with strip-literal before it looks for these calls. A template literal keeps the code of its ${...} parts.
//   maskLiterals(code) -> string of the same length

// After one of these (or a keyword below) a slash starts a regular expression; after anything else it divides.
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const WORD = /[A-Za-z0-9_$]/;

export function maskLiterals(code) {
  const out = code.split('');
  const n = code.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  // Open braces: '{' for a block or object, 'tpl' for the ${ of a template literal.
  const braces = [];
  let prev = '';
  // Scans template text from i (just after ` or }) to its end or to a ${. Returns the index after what it consumed.
  const templateText = i => {
    const start = i;
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(start, i); return {next: i + 1, open: false}; }
      if (c === '$' && code[i + 1] === '{') { blank(start, i); braces.push('tpl'); return {next: i + 2, open: true}; }
      i++;
    }
    blank(start, n);
    return {next: n, open: false};
  };
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { let e = code.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue; }
    if (c === '/' && code[i + 1] === '*') { let e = code.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; blank(i, e); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1; prev = 'str'; continue;
    }
    if (c === '`') { const t = templateText(i + 1); i = t.next; prev = t.open ? '{' : 'str'; continue; }
    if (c === '{') { braces.push('{'); prev = '{'; i++; continue; }
    if (c === '}') {
      if (braces.pop() === 'tpl') { const t = templateText(i + 1); i = t.next; prev = t.open ? '{' : 'str'; continue; }
      prev = '}'; i++; continue;
    }
    if (c === '/' && (BEFORE_REGEX.has(prev) || KEYWORDS.has(prev))) {
      let j = i + 1, inClass = false;
      while (j < n && code[j] !== '\n' && (inClass || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      if (j < n && code[j] === '/') { blank(i + 1, j); j++; while (j < n && WORD.test(code[j])) j++; i = j; prev = 'str'; continue; }
    }
    if (WORD.test(c)) { let j = i; while (j < n && WORD.test(code[j])) j++; prev = code.slice(i, j); i = j; continue; }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** The index of the parenthesis that closes the one at `open`, in masked code; -1 when there is none. */
export function closingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) return i;
  }
  return -1;
}
