// The runtime's page with the platform features of webPlatform.ts and pageApis.ts (streams, a streaming TextDecoder,
// streamed fetch, the Cache API, FontFace, IntersectionObserver, forms and URL fixes), without a game.
// Tests/unit/platform-apis-page.mjs boots a fresh copy for each test.
import '../../Runtime/src/polyfills';
import '../../Runtime/src/urlLive';
import '../../Runtime/src/dom';
import '../../Runtime/src/fieldValidity';
import '../../Runtime/src/fetch';
export {uiInput, publishUI} from '../../Runtime/src/ui';
export {layoutBoxes, setViewport, submitForm} from '../../Runtime/src/dom';
export {bufferOrigin} from '../../Runtime/src/fetch';
