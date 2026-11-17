// Runs inside the CEF overlay. Shows the game's DOM (sent from Puerts as HTML) and sends back
// every element's laid-out box and the DOM events the player causes. Game rules and handlers stay
// in Puerts; this page only presents and forwards.
(function () {
  const ATTR = 'data-jsgb';
  let patching = false, layoutPending = false, focusMark = null, cursor = '';
  const send = packet => { try { if (window.ue && window.ue.jsgb) window.ue.jsgb.sendinput(JSON.stringify(packet)); } catch (e) { console.error(e); } };
  const id = node => node && node.nodeType === 1 ? node.getAttribute(ATTR) : null;
  // The nearest mirrored element: events on overlay-only nodes go to their mirrored ancestor.
  const owner = node => { while (node && node.nodeType === 1 && !id(node)) node = node.parentElement; return node && node.nodeType === 1 ? node : null; };

  function sync(current, next) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); return; }
    if (current.nodeType !== 1) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
    for (const a of [...current.attributes]) if (!next.hasAttribute(a.name)) current.removeAttribute(a.name);
    for (const a of next.attributes) if (current.getAttribute(a.name) !== a.value) current.setAttribute(a.name, a.value);
    if (current !== document.activeElement && 'value' in current && next.hasAttribute('value') && current.value !== next.getAttribute('value')) current.value = next.getAttribute('value');
    if ('checked' in current) current.checked = next.hasAttribute('checked');
    // A focused editable region keeps the text typed here until the page changes it (jsgb-ui-edit.js).
    if (window.JsgbEdit && window.JsgbEdit.keep(current, next)) return;
    const old = [...current.childNodes], keyed = new Map(old.filter(n => id(n)).map(n => [id(n), n]));
    let position = 0;
    for (const child of [...next.childNodes]) {
      let found = id(child) ? keyed.get(id(child)) : old[position];
      if (found && found.parentNode !== current) found = null;
      if (found && id(found) !== id(child)) found = null;
      if (!found) { found = child.cloneNode(true); current.insertBefore(found, current.childNodes[position] || null); }
      else { if (current.childNodes[position] !== found) current.insertBefore(found, current.childNodes[position] || null); sync(found, child); }
      position++;
    }
    while (current.childNodes.length > position) current.lastChild.remove();
  }

  let appliedVersion = -1;
  function layout() {
    layoutPending = false;
    const rects = {};
    for (const node of document.querySelectorAll('[' + ATTR + ']')) {
      const r = node.getBoundingClientRect(), c = getComputedStyle(node);
      // The content box too (inside padding and borders), which resize observers report as contentRect.
      const cw = node.clientWidth ? node.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight) : r.width;
      const ch = node.clientHeight ? node.clientHeight - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom) : r.height;
      rects[id(node)] = {x: r.x, y: r.y, width: r.width, height: r.height, cw, ch, display: c.display, visibility: c.visibility, opacity: c.opacity, pointerEvents: c.pointerEvents, fontSize: c.fontSize, color: c.color};
      if (window.JsgbEdit) window.JsgbEdit.measure(node, rects[id(node)]);
    }
    send({type: 'host-layout', version: appliedVersion, width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio, rects});
  }
  // WebKit pauses animation frames while it takes the window for hidden (another window over it, or the app inactive),
  // and the page then never learned its layout: measured containers such as a 3D canvas stayed at zero. A timer
  // stands in when no frame comes.
  const scheduleLayout = () => {
    if (layoutPending) return;
    layoutPending = true;
    requestAnimationFrame(() => { if (layoutPending) layout(); });
    setTimeout(() => { if (layoutPending) layout(); }, 100);
  };

  const report = text => send({type: 'host-log', text: String(text).slice(0, 500)});
  window.addEventListener('error', e => report(`${e.message} at ${e.filename}:${e.lineno}`));
  const canvases = new Map();
  function paintCanvas(id) {
    const image = canvases.get(id), el = document.querySelector(`[data-jsgb="${id}"]`);
    if (!image || !el || el.tagName !== 'CANVAS') return;
    if (el.width !== image.width) el.width = image.width;
    if (el.height !== image.height) el.height = image.height;
    // The overlay hides the game's canvases (Unreal draws the 3D view); one with mirrored pixels shows.
    el.setAttribute('data-jsgb-pixels', '');
    if (image.empty) el.getContext('2d').clearRect(0, 0, el.width, el.height); else el.getContext('2d').putImageData(image, 0, 0);
  }
  // Focus the game moved itself (Runtime/src/focusMirror.ts marks the element). Acting only when the mark moves keeps
  // this from undoing the player's own clicks, which reach the game a moment later and move the mark themselves.
  function followFocus() {
    const marked = document.querySelector('[data-jsgb-focus]'), how = marked && marked.getAttribute('data-jsgb-focus');
    const mark = marked ? id(marked) + ':' + how : null;
    if (mark === focusMark) return;
    const was = focusMark && focusMark.slice(0, focusMark.indexOf(':'));
    focusMark = mark; patching = true;
    try {
      if (marked && how !== 'overlay' && document.activeElement !== marked) marked.focus({preventScroll: true});
      if (marked && how === 'select' && marked.select) marked.select();
      // The game let go of the field the overlay still has; one the player moved to since is left alone.
      if (!marked && was && id(document.activeElement) === was) document.activeElement.blur();
    } finally { patching = false; }
  }
  // Unreal's cursor follows the page's, as a browser shows it (the host maps the CSS name to its own cursors).
  function followCursor(el) {
    if (!el || el.nodeType !== 1) return;
    let c = String(getComputedStyle(el).cursor || 'auto').split(',').pop().trim();
    if (c === 'auto') c = el.isContentEditable || (el.matches && el.matches('textarea,input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image])')) ? 'text' : 'default';
    if (c !== cursor) { cursor = c; send({type: 'host-cursor', cursor: c}); }
  }
  window.JsGameUI = {
    apply(html, version) {
      // The host's UI version this page now shows; layout reports carry it back, so scripts know what is on screen.
      if (version !== undefined) appliedVersion = version;
      const full = html.startsWith('<html');
      const parsed = new DOMParser().parseFromString(full ? '<!doctype html>' + html : '<!doctype html><html><head></head>' + html + '</html>', 'text/html');
      if (full) {
        // The game's <html> attributes, such as CSS variables in its style attribute.
        const root = document.documentElement, next = parsed.documentElement;
        for (const a of [...root.attributes]) if (!next.hasAttribute(a.name)) root.removeAttribute(a.name);
        for (const a of next.attributes) if (!/^on/i.test(a.name) && root.getAttribute(a.name) !== a.value) root.setAttribute(a.name, a.value);
      }
      // Styles the game added to its <head> at run time, kept in a stylesheet of their own after the page CSS.
      const headCss = parsed.head?.querySelector('style[data-jsgb-head]')?.textContent ?? '';
      let headStyle = document.getElementById('jsgb-head-css');
      if (headCss && !headStyle) { headStyle = document.createElement('style'); headStyle.id = 'jsgb-head-css'; document.head.append(headStyle); }
      if (headStyle && headStyle.textContent !== headCss) headStyle.textContent = headCss;
      parsed.querySelectorAll('script').forEach(n => n.remove());
      for (const n of parsed.querySelectorAll('*')) for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      patching = true; sync(document.body, parsed.body); patching = false;
      followFocus();
      // What the page asked for with this publish: a selection, a scroll, an editing command (jsgb-ui-edit.js).
      if (window.JsgbEdit) window.JsgbEdit.run(parsed);
      for (const id of canvases.keys()) paintCanvas(id);
      scheduleLayout();
    },
    // The pixels of a 2D canvas the game drew (a portrait, a minimap), as base64 RGBA.
    canvas(id, width, height, base64) {
      try {
        // No pixels means the canvas is clear.
        canvases.set(id, base64 ? new ImageData(Uint8ClampedArray.from(atob(base64), c => c.charCodeAt(0)), width, height) : {width, height, empty: true});
        paintCanvas(id);
      } catch (e) { report('canvas ' + id + ': ' + e); }
    },
    reset() { document.body.replaceChildren(); },
    // A stylesheet-only edit: swap the page CSS in place and report once it is painted.
    css(text, version) {
      document.getElementById('jsgb-page-css').textContent = text;
      requestAnimationFrame(() => requestAnimationFrame(() => { send({type: 'host-css', version}); scheduleLayout(); }));
    },
  };
  window.JsGameUI.layout = scheduleLayout;

  const pointer = ['click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'wheel'];
  // Drags: the game keeps a drag's data (Runtime/src/dragDrop.ts); the overlay sends what it may see of it (kinds, types, how
  // many files, and any text at the drop) and accepts every drag, so its web view never opens a dropped file itself.
  const drags = ['dragstart', 'drag', 'dragend', 'dragenter', 'dragover', 'dragleave', 'drop'];
  const dragInfo = (dt, type) => {
    const info = {types: [...dt.types], items: [...dt.items].map(i => ({kind: i.kind, type: i.type})), files: dt.files.length, effectAllowed: dt.effectAllowed};
    if (type === 'drop') { info.data = {}; for (const t of dt.types) if (t !== 'Files') info.data[t] = dt.getData(t); }
    return info;
  };
  for (const type of [...pointer, ...drags, 'input', 'change', 'toggle', 'focusin', 'focusout', 'submit']) document.addEventListener(type, event => {
    if (patching) return;
    if (type === 'pointermove' || type === 'pointerover') followCursor(event.target);
    // A move or release outside the mirrored page (a drag that left it) still goes to the game, at its body.
    const target = owner(event.target) || (/^(pointermove|pointerup|pointercancel|mousemove|mouseup)$/.test(type) ? owner(document.body) : null);
    if (!target) return;
    const p = {type, id: id(target), button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      offsetX: event.offsetX, offsetY: event.offsetY, movementX: event.movementX, movementY: event.movementY, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
      shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, pointerId: event.pointerId, pointerType: event.pointerType, detail: event.detail};
    if ('value' in target) p.value = target.value;
    // A file input's files are chosen in the game (Runtime/src/filePicker.ts); the overlay's own copy never has any.
    if (target.type === 'file') delete p.value;
    if (event.dataTransfer) p.drag = dragInfo(event.dataTransfer, type);
    if ('checked' in target) p.checked = target.checked;
    if (type === 'toggle') p.open = target.open;
    // The element the pointer or focus came from or went to (React's enter and leave events need it).
    if ('relatedTarget' in event) p.relatedId = id(owner(event.relatedTarget));
    if (window.JsgbEdit) window.JsgbEdit.extend(p, event);
    send(p);
    if (type === 'contextmenu' || type === 'submit' || (type === 'wheel' && target.tagName === 'CANVAS')) event.preventDefault();
    // A link is the game's to follow (Runtime/src/location.ts): the overlay itself never leaves its page.
    if ((type === 'click' || type === 'auxclick') && event.target.closest && event.target.closest('a[href],area[href]')) event.preventDefault();
    // The open panel is the game's to show (the native one, Runtime/src/filePicker.ts), and drops are the game's to take.
    if (/^(dragenter|dragover|drop)$/.test(type) || (type === 'click' && event.target.matches && event.target.matches('input[type=file]'))) event.preventDefault();
  }, {capture: true, passive: false});
  // Cmd or Ctrl with C, X or V outside a field: the overlay holds the copy, cut or paste back and the game runs it
  // (Runtime/src/clipboardCommands.ts), with the text the person selected here for a copy.
  const clipKey = (type, event, held) => type === 'keydown' && held && (event.metaKey || event.ctrlKey) && /^Key[CXV]$/.test(event.code)
    ? {clip: true, selection: String(getSelection() || '')} : {};
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
    const target = owner(event.target);
    // Fields and editable text keep their keys: typing goes into them natively.
    const held = !event.target.isContentEditable && (!event.target.matches || !event.target.matches('input,select,textarea'));
    const p = {type, ...(target && target !== document.body ? {id: id(target)} : {}), key: event.key, code: event.code, repeat: event.repeat, location: event.location,
      shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, keyCode: event.keyCode, which: event.which, ...clipKey(type, event, held)};
    // IME state, the caret, and a key the page may cancel held back in rich text (jsgb-ui-edit.js).
    if (window.JsgbEdit) window.JsgbEdit.extend(p, event);
    send(p);
    if (held) event.preventDefault();
  }, true);
  window.addEventListener('resize', scheduleLayout);
  window.addEventListener('blur', () => send({type: 'blur'}));
  new ResizeObserver(scheduleLayout).observe(document.documentElement);
})();
