// The runtime's page with the browser features webGaps.ts adds (Runtime/src/webGaps.ts), without a game.
// Tests/unit/web-gaps-page.mjs boots a fresh copy for each test.
import '../../Runtime/src/polyfills';
import '../../Runtime/src/dom';
import '../../Runtime/src/webGaps';
export {uiInput} from '../../Runtime/src/ui';
export {layoutBoxes, setViewport} from '../../Runtime/src/dom';
export {collate} from '../../Runtime/src/collation';
export {normalizeText} from '../../Runtime/src/textNormalize';
export {canonicalZone, zoneOffset, partsOf, localZone} from '../../Runtime/src/timeZones';
export {matchesMedia} from '../../Runtime/src/mediaQueries';
export {customProperty, parseCustomProps, specificity} from '../../Runtime/src/cssCustomProps';
export {elementsAt} from '../../Runtime/src/pointHitTest';
