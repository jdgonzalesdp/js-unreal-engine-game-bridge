#pragma once

/** WebAssembly features a game's modules need that the V8 Puerts runs ships behind a flag. V8 9.4 (Puerts' Mac build)
 *  rejects modules that use reference types (externref), which wasm-bindgen and newer Rust toolchains emit by default:
 *  Spark's splat worker failed to start, so no Gaussian splat ever loaded. V8 9.6 and later have them on.
 *
 *  Flags belong to one copy of V8. On Mac this module links its own static copy, used by the worker isolates
 *  (JsgbWorkers.cpp), apart from the copy in Puerts' JsEnv module that runs the page; the page's copy is set in Puerts
 *  itself (Patches/puerts-wasm-reftypes.patch). Call this before an isolate in this module's copy compiles WebAssembly:
 *  V8 9.4 reads the flag at each compile, so calling it again is harmless. */
void JsgbEnableWasmFeatures();
