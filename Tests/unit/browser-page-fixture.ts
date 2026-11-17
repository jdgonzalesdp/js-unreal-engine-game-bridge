// A page as the runtime sets it up for a game, without the game: the browser globals, the DOM, fetch and the page's
// address. Tests/unit/browser-page.mjs boots a fresh copy for each simulated page start.
import '../../Runtime/src/polyfills';
import '../../Runtime/src/subtle';
import '../../Runtime/src/urlLive';
import '../../Runtime/src/locks';
import '../../Runtime/src/dom';
import '../../Runtime/src/fetch';
export {flushStorage} from '../../Runtime/src/dom';
export {navigateTo, followLink} from '../../Runtime/src/location';
export {uiInput, publishUI} from '../../Runtime/src/ui';
