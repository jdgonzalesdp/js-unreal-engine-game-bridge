/** Platform features of a browser that Puerts' V8 lacks and every JavaScript environment here needs, the page and its
 *  threaded workers alike: a TextDecoder that can stream, the Streams standard (ReadableStream, WritableStream,
 *  TransformStream and the text and compression streams), Blob.stream(), URL's userinfo, canParse and parse, abort
 *  reasons named as browsers name them, and on the page the Cache API. polyfills.ts installs them last, once Blob, URL
 *  and TextEncoder exist. Each install keeps an engine's own version where it has one. */
import {installTextDecoder} from './textDecoder';
import {installReadableStream} from './streamsReadable';
import {installWritableStreams} from './streamsWritable';
import {installCodingStreams} from './streamsCodec';
import {installUrlFix} from './urlFix';
import {installCacheStorage} from './cacheStorage';
import {installAbortReasons} from './abortReasons';

export function installWebPlatform() {
  installTextDecoder();
  installReadableStream();
  installWritableStreams();
  installCodingStreams();
  installUrlFix();
  installCacheStorage();
  installAbortReasons();
}
