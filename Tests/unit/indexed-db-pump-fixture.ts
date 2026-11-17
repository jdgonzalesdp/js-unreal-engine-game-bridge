// The runtime's page with IndexedDB on the runtime's own timers (timers.ts), as Unreal drives it: one pumpFrame per
// host tick. Tests/unit/indexed-db-page.mjs boots it with {pump: true}.
import '../../Runtime/src/polyfills';
import {immediatesPending, pumpFrame, runTimers} from '../../Runtime/src/timers';
import '../../Runtime/src/dom';
import '../../Runtime/src/indexedDb';
import {onLeaveBusy} from '../../Runtime/src/leave';
export {flushStorage} from '../../Runtime/src/dom';
export {leaveStep} from '../../Runtime/src/leave';
export {pumpFrame, runTimers};
// As entry.ts does: a leave waits while IndexedDB has steps queued.
onLeaveBusy(immediatesPending);
