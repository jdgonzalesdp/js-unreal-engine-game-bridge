/** Browser features a sweep of a real app found missing or wrong here, each in its own module. They load after the
 *  DOM (dom.ts) and Intl (intl.ts), some of whose stand-ins they replace, and before the game's module runs.
 *  Each install is guarded, so an engine that already has the feature keeps its own. */
import './textNormalize';
import './collation';
import './timeZones';
import './textSelection';
import './fieldValidity';
import './domGaps';
import './pointHitTest';
import './mediaQueries';
import './cssCustomProps';
// The system's clipboard and its light or dark look (navigator.clipboard, prefers-color-scheme changes).
import './clipboard';
import './appearance';
