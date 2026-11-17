/** window.alert, confirm and prompt as a browser has them: a dialog the page's script waits for, and the person's
 *  answer. The host shows the system's own (__jsgbHost.dialog: an alert sheet on the game's window on a Mac,
 *  Source/JsGameBridge/Private/JsgbDialogsMac.mm) and the call returns only when the person answers, as in a browser.
 *  Until now confirm answered OK by itself, so every "Delete this?" a page asked went ahead without the person.
 *  A host without dialogs (the Node smoke test) keeps the old stand-ins, logged so a run shows what it skipped: alert only
 *  logs, confirm answers OK and prompt answers Cancel. */
import {host} from './host';

const g = globalThis as Record<string, any>;
/** The host's dialog: "1" and any typed text for OK, "0" for Cancel (UJsgbBridge::ShowDialog). */
export type HostDialog = (kind: 'alert' | 'confirm' | 'prompt', message: string, value: string) => string;

// What a browser shows for each argument: alert(x) shows String(x) and alert() nothing; confirm and prompt treat a
// missing or undefined message (and a prompt's default text) as empty.
const alertText = (args: unknown[]) => args.length ? String(args[0]) : '';
const optionalText = (v: unknown) => v === undefined ? '' : String(v);

function ask(show: HostDialog, kind: 'alert' | 'confirm' | 'prompt', message: string, value: string): string {
  try { return String(show(kind, message, value) ?? '0'); }
  catch (error) {
    // A dialog that could not open answers Cancel: a page's destructive step must not go ahead unasked.
    host.log('error', `${kind} dialog failed: ${error instanceof Error ? error.stack : error}`);
    return '0';
  }
}

/** Installs alert, confirm and prompt on the window (dom.ts calls it as the page is built). */
export function installDialogs() {
  const show = (host as {dialog?: HostDialog}).dialog;
  if (typeof show !== 'function') {
    g.alert = function alert(...args: unknown[]) { host.log('warn', 'alert: ' + alertText(args)); };
    g.confirm = function confirm(message?: unknown) { host.log('warn', 'confirm (no dialog on this host, answered OK): ' + optionalText(message)); return true; };
    g.prompt = function prompt(message?: unknown) { host.log('warn', 'prompt (no dialog on this host, answered Cancel): ' + optionalText(message)); return null; };
    return;
  }
  g.alert = function alert(...args: unknown[]) { ask(show, 'alert', alertText(args), ''); };
  g.confirm = function confirm(message?: unknown) { return ask(show, 'confirm', optionalText(message), '').charAt(0) === '1'; };
  g.prompt = function prompt(message?: unknown, value?: unknown) {
    const answer = ask(show, 'prompt', optionalText(message), optionalText(value));
    return answer.charAt(0) === '1' ? answer.slice(1) : null;
  };
}
