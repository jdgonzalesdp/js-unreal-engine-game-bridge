// Runs in the UI overlay after jsgb-ui-client.js (the host appends every JavaScript/jsgb-ui-*.js to it). The overlay's
// text editing, selection and scrolling, kept in step with the game's page (Runtime/src/overlayEdits.ts and its
// neighbours). The overlay edits, selects and scrolls natively; this reports what happened and does what the page asks
// in the commands that come with each publish (Runtime/src/overlayCommands.ts).
(function () {
  const ATTR = 'data-jsgb', REV = 'data-jsgb-rev';
  const send = packet => { try { if (window.ue && window.ue.jsgb) window.ue.jsgb.sendinput(JSON.stringify(packet)); } catch (e) { console.error(e); } };
  const id = node => node && node.nodeType === 1 ? node.getAttribute(ATTR) : null;
  const owner = node => { while (node && node.nodeType === 1 && !id(node)) node = node.parentElement; return node && node.nodeType === 1 ? node : null; };
  const byId = v => document.querySelector('[' + ATTR + '="' + CSS.escape(String(v)) + '"]');
  const textField = el => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && typeof el.selectionStart === 'number'));
  // The editing host a node is in: the outermost element of its run of editable ancestors.
  const hostOf = node => {
    let found = null;
    for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el && el.isContentEditable; el = el.parentElement) found = el;
    return found;
  };
  const focusedIn = el => !!el && !!document.activeElement && (el === document.activeElement || el.contains(document.activeElement));

  // ---- Selection points, written as Runtime/src/selectionPoints.ts reads them: an element (by id, then element child
  // indexes; the editing host inside an editable region), the element children before the point, and the characters
  // into the text after them.
  function writePoint(node, offset) {
    if (!node) return null;
    const text = node.nodeType === 3, parent = text ? node.parentNode : node;
    if (!parent || parent.nodeType !== 1) return null;
    const kids = parent.childNodes, upTo = text ? Array.prototype.indexOf.call(kids, node) : offset;
    let c = 0, t = 0;
    for (let i = 0; i < upTo && i < kids.length; i++) { if (kids[i].nodeType === 1) { c++; t = 0; } else if (kids[i].nodeType === 3) t += kids[i].data.length; }
    if (text) t += Math.max(0, Math.min(offset, node.data.length));
    const host = hostOf(parent), path = [];
    let el = parent;
    while (el && !(host ? el === host : id(el))) { const up = el.parentElement; if (!up) return null; path.unshift(Array.prototype.indexOf.call(up.children, el)); el = up; }
    return el && id(el) ? {id: id(el), path, c, t} : null;
  }
  function readPoint(p) {
    let el = p && byId(p.id);
    for (const i of (p && p.path) || []) { el = el && el.children[i]; if (!el) return null; }
    if (!el) return null;
    const kids = el.childNodes;
    let i = 0, c = 0, acc = 0, last = null;
    for (; i < kids.length && c < (p.c | 0); i++) if (kids[i].nodeType === 1) c++;
    for (let j = i; j < kids.length && kids[j].nodeType !== 1; j++) {
      if (kids[j].nodeType !== 3) continue;
      if ((p.t | 0) <= acc + kids[j].data.length) return {node: kids[j], offset: Math.max(0, (p.t | 0) - acc)};
      acc += kids[j].data.length; last = kids[j];
    }
    return last ? {node: last, offset: last.data.length} : {node: el, offset: i};
  }
  // The selection as packets carry it: a focused text field's (fsel) or the document's (sel). Packets add the number of
  // the last command run here (seen): the page drops a selection reported before its own reached this side.
  const reported = () => { const s = selection(); return s ? {...s, seen: ran} : {}; };
  function selection() {
    const a = document.activeElement;
    if (textField(a)) return id(a) ? {fsel: {start: a.selectionStart, end: a.selectionEnd, dir: a.selectionDirection}} : null;
    const s = document.getSelection();
    if (!s || !s.rangeCount) return {sel: {none: true}};
    const anchor = writePoint(s.anchorNode, s.anchorOffset), focus = writePoint(s.focusNode, s.focusOffset);
    return anchor && focus ? {sel: {anchor, focus}} : null;
  }
  let lastSel = '';
  const remember = () => { lastSel = JSON.stringify(selection()); };
  document.addEventListener('selectionchange', () => {
    const s = selection(), key = JSON.stringify(s);
    if (!s || key === lastSel) return;
    lastSel = key;
    send({type: 'selection', ...(s.fsel ? {id: id(document.activeElement)} : {}), ...s, seen: ran});
  });

  // ---- Held defaults: a key or a paste the page may cancel is kept back, and done here once the page lets it through
  // (its answer is a "held" command). Keys typed while one is out wait their turn, so they land in order.
  let heldCount = 0, editCount = 0;
  const waiting = [];
  function hold(event, editor, action) {
    const entry = {n: ++heldCount, editor, action, done: false, ok: false};
    waiting.push(entry);
    setTimeout(() => settle(entry.n, true), 2000);
    if (event) event.preventDefault();
    return entry.n;
  }
  function settle(n, ok) {
    const entry = waiting.find(e => e.n === n);
    if (!entry || entry.done) return;
    entry.done = true; entry.ok = ok;
    while (waiting.length && waiting[0].done) { const e = waiting.shift(); if (e.ok) perform(e); }
  }
  function perform(e) {
    if (!e.editor.isConnected || !focusedIn(e.editor)) return;
    const [cmd, value] = e.action;
    if (cmd !== 'paste') { document.execCommand(cmd, false, value); return; }
    const html = value['text/html'], text = value['text/plain'] || '';
    if (html && hostOf(e.editor)) document.execCommand('insertHTML', false, cleanPaste(html));
    else if (text) document.execCommand('insertText', false, text);
  }
  // Pasted HTML goes in without scripts, frames, styles or event handlers, as a browser's own paste does.
  function cleanPaste(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta,template').forEach(n => n.remove());
    for (const n of doc.body.querySelectorAll('*')) for (const a of [...n.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    return doc.body.innerHTML;
  }
  // The default a key would have in the focused editor; held only when it edits text the page may want to stop.
  function keyAction(event, editor, host) {
    const mod = event.metaKey || event.ctrlKey, k = event.key;
    if (k === 'Enter' && !mod && !event.altKey) return host ? [event.shiftKey ? 'insertLineBreak' : 'insertParagraph'] : editor.tagName === 'TEXTAREA' ? ['insertText', '\n'] : null;
    if (host && mod && !event.altKey && !event.shiftKey && /^[biu]$/i.test(k)) return [{b: 'bold', i: 'italic', u: 'underline'}[k.toLowerCase()]];
    if (mod) return null;
    if ([...k].length === 1) return ['insertText', k];
    if (!event.altKey && k === 'Backspace') return ['delete'];
    if (!event.altKey && k === 'Delete') return ['forwardDelete'];
    return null;
  }
  const startsHold = (event, host) => event.key === 'Enter' || (host && (event.metaKey || event.ctrlKey));

  // ---- Editable regions: an edit sends the region's HTML (no bridge ids) and the revision it was made on.
  function regionHtml(host) {
    const copy = host.cloneNode(true);
    for (const n of [copy, ...copy.querySelectorAll('*')]) for (const a of [...n.attributes]) if (a.name.startsWith(ATTR)) n.removeAttribute(a.name);
    return copy.innerHTML;
  }

  // ---- What the page asks for, with each publish.
  let epoch = null, ran = 0;
  function command(c) {
    const el = c.id !== undefined ? byId(c.id) : null;
    if (c.k === 'held') settle(c.held, !!c.ok);
    else if (c.k === 'sel') {
      const s = document.getSelection();
      if (c.none) s.removeAllRanges();
      else { const a = readPoint(c.anchor), f = readPoint(c.focus); if (a && f) s.setBaseAndExtent(a.node, a.offset, f.node, f.offset); }
      remember();
    } else if (c.k === 'fsel' && el && textField(el)) {
      // The page's value comes along only when the page had every edit made here: it changed the value itself.
      if (typeof c.value === 'string' && el.value !== c.value && c.edit >= editCount) el.value = c.value;
      el.setSelectionRange(c.start, c.end, c.dir || 'none');
      remember();
    } else if (c.k === 'fval' && el && 'value' in el) {
      // A value the page wrote itself (a sent message cleared); typing here since wins, as it reaches the page next.
      if (typeof c.value === 'string' && el.value !== c.value && c.edit >= editCount) { el.value = c.value; remember(); }
    } else if (c.k === 'exec' && el) {
      if (!focusedIn(el)) el.focus({preventScroll: true});
      document.execCommand(c.cmd, false, c.value === null ? undefined : c.value);
    } else if (c.k === 'scroll' && el && window.JsgbEdit.scroll) window.JsgbEdit.scroll(el, c);
  }

  window.JsgbEdit = {
    // jsgb-ui-client.js sync(): true keeps the overlay's own children of a focused editable region. Its copy is ahead
    // while the page's revision of the region holds; a new revision is the page's own change, shown as it comes.
    keep(current, next) {
      // The attribute first: sync calls this for every element, and isContentEditable can make WebKit resolve styles.
      if (!current.hasAttribute('contenteditable') || !current.isContentEditable || (current.parentElement && current.parentElement.isContentEditable)) return false;
      const rev = next.getAttribute(REV) || '';
      if (focusedIn(current) && current.__jsgbRev === rev) return true;
      current.__jsgbRev = rev;
      return false;
    },
    // jsgb-ui-client.js apply(): runs the commands of this publish, each once.
    run(parsed) {
      const meta = parsed.head && parsed.head.querySelector('meta[name="jsgb-commands"]');
      if (!meta) return;
      let data;
      try { data = JSON.parse(meta.getAttribute('content')); } catch (e) { return; }
      if (data.epoch !== epoch) { epoch = data.epoch; ran = 0; }
      for (const c of data.list || []) {
        if (!(c.n > ran)) continue;
        ran = c.n;
        try { command(c); } catch (e) { send({type: 'host-log', text: 'overlay command ' + c.k + ': ' + e}); }
      }
    },
    // jsgb-ui-client.js layout(), scroll commands and pen samples: jsgb-ui-motion.js fills these in.
    measure() {}, scroll: null, pen: null,
    // jsgb-ui-client.js event forwarding: what a packet adds for editing, selection and pens.
    extend(p, event) {
      const type = event.type;
      if (type.startsWith('pointer')) { if (window.JsgbEdit.pen) window.JsgbEdit.pen(p, event); return; }
      if (!/^(keydown|keyup|input|mousedown)$/.test(type)) return;
      const t = event.target, host = hostOf(t), editor = host || (textField(t) ? t : null);
      if (type === 'keydown' || type === 'keyup') {
        p.isComposing = !!event.isComposing;
        if (editor) Object.assign(p, reported());
        if (type === 'keydown' && editor && !p.isComposing && event.keyCode !== 229) {
          const action = keyAction(event, editor, host);
          if (action && (startsHold(event, host) || waiting.some(e => e.editor === editor))) p.held = hold(event, editor, action);
        }
      } else if (type === 'input') {
        Object.assign(p, {inputType: event.inputType, data: event.data, isComposing: !!event.isComposing, edit: ++editCount});
        if (host) { p.id = id(host); p.html = regionHtml(host); p.rev = host.getAttribute(REV) || ''; }
        if (editor) Object.assign(p, reported());
      } else if (type === 'mousedown' && event.button === 0) {
        // A toolbar button pressed while text is being edited keeps the focus and the selection until the page says
        // otherwise (Runtime/src/overlayEdits.ts): its mousedown handler may cancel the press, as formatting bars do.
        const a = document.activeElement, editing = a && a !== document.body && (a.isContentEditable || textField(a));
        if (editing && t.closest && !a.contains(t) && t.closest('button,[role=button],[role=menuitem],[role=tab],[role=option]') && !t.closest('input,textarea,select,[contenteditable]')) {
          p.held = true; event.preventDefault();
        }
      }
    },
  };

  // ---- Input methods: the text in progress shows natively in the field; the page sees the events.
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(type, event => {
    const target = owner(event.target);
    if (target) send({type, id: id(target), data: event.data});
  }, true);

  // ---- Clipboard: a paste is held until the page's listeners have seen it, files read in; copy and cut run here.
  const readFile = file => new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve({name: file.name, type: file.type, lastModified: file.lastModified, base64: String(reader.result).slice(String(reader.result).indexOf(',') + 1)});
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  document.addEventListener('paste', event => {
    const target = owner(event.target) || owner(document.body), dt = event.clipboardData;
    if (!target || !dt) return;
    const data = {};
    for (const type of dt.types) if (type !== 'Files') data[type] = dt.getData(type);
    const files = [...dt.files].filter(f => f.size <= 64 << 20);
    const editor = hostOf(event.target) || (textField(document.activeElement) ? document.activeElement : document.body);
    const p = {type: 'paste', id: id(target), held: hold(event, editor, ['paste', data]), ...reported()};
    if (!files.length) { send({...p, clip: {data}}); return; }
    Promise.all(files.map(readFile)).then(read => send({...p, clip: {data, files: read.filter(Boolean)}}));
  }, true);
  for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
    const target = owner(event.target) || owner(document.body);
    if (target) send({type, id: id(target)});
  }, true);
})();
