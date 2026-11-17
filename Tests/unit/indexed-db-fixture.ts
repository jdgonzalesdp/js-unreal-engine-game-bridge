// The runtime's page with IndexedDB, as the Unreal host starts it, without a game. Tests/unit/indexed-db-page.mjs boots
// a fresh copy for each simulated start, over a host store that outlives the boots.
import '../../Runtime/src/polyfills';
import '../../Runtime/src/dom';
import '../../Runtime/src/indexedDb';
export {flushStorage} from '../../Runtime/src/dom';
export {leaveStep} from '../../Runtime/src/leave';
