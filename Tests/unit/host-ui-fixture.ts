// The runtime's page with what it takes from the system (dialogs, clipboard, look, time zone) and page drags, without
// a game. Tests/unit/host-ui-page.mjs boots a fresh copy for each test.
import '../../Runtime/src/polyfills';
import '../../Runtime/src/dom';
import '../../Runtime/src/webGaps';
export {uiInput} from '../../Runtime/src/ui';
export {checkAppearance} from '../../Runtime/src/appearance';
export {matchesMedia} from '../../Runtime/src/mediaQueries';
export {localZone} from '../../Runtime/src/timeZones';
export {permits} from '../../Runtime/src/pageDrag';
export {shortcutCommand} from '../../Runtime/src/clipboardCommands';
