/** Page features that need the page's document (dom.ts installs them last): FontFace and document.fonts
 *  (fontFaces.ts), IntersectionObserver over the overlay's layout reports (intersectionObserver.ts) and real
 *  <form> elements (forms.ts). */
import {installFontFaces} from './fontFaces';
import {installIntersectionObserver} from './intersectionObserver';
import {installForms} from './forms';

type Box = {x: number; y: number; width: number; height: number};
export function installPageApis(page: Record<string, any>, layoutBoxes: Map<string, unknown>, boxOf: (el: Record<string, any>) => Box | undefined) {
  installFontFaces(page.document);
  installIntersectionObserver(layoutBoxes, boxOf);
  installForms(page, page.document);
}
