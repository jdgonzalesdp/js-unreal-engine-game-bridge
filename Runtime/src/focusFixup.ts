/** The focus fixup rule, as browsers have it: when the focused element leaves the document, focus goes back to the
 *  body, and no blur or focusout fires (WebKit and the HTML spec agree on that). The page's DOM here only remembered
 *  what focus() last named, so a field removed while it had focus stayed document.activeElement for good. A colour
 *  chip in a menu that closed on the next click kept every viewport shortcut off (WASD, tool letters), because pages
 *  such as PrepViz stand their keys down while document.activeElement is a field.
 *  The overlay can't report that blur: the menu closes on the pointerdown, so its focusout names an element the page
 *  no longer has. dom.ts reads activeElement through this. */
export function stillFocused<T>(el: T | null): T | null {
  return el && (el as {isConnected?: boolean}).isConnected === false ? null : el;
}
