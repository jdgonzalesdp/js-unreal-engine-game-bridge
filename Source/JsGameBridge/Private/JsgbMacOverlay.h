#pragma once

#if PLATFORM_MAC
struct FKeyEvent;

/** Mac: makes the UI overlay's native WKWebView draw no background of its own, and hides the Metal view the engine
 *  stacks above it (which holds only stale frames in a game window), so the game shows through. It also keeps the web
 *  view on the whole game view and gives it the keyboard while nothing else has it. Cheap and safe to call often: the
 *  engine creates the native views lazily and may replace them. */
void JsgbMakeMacWebViewsTransparent();

/** Mac: does the same for each web view and Metal view as the engine adds them, before they draw a frame, so the stale
 *  Metal view never reaches the screen (it flickered for up to 30 frames before the periodic call caught it). Call
 *  once the game window exists, before the overlay draws; it waits for the main thread. */
void JsgbWatchMacNativeLayers();

/** Mac: re-pins every overlay web view to its window's content bounds (FillContent). The engine
 *  re-sizes the web view with the title bar added (1600x931 in a 900-tall window) whenever Slate
 *  lays out, and a replaced web view has no frame watch yet; at 931 the mouse reads a titlebar
 *  low against the 900-tall layout, so menu hover lands a row under the pointer. Called on a
 *  timer from the host tick; only ever moves a frame that is wrong. */
void JsgbMacPinOverlay();

/** Mac: sends Cmd+C, Cmd+X or Cmd+V to the overlay page as a key press, as a browser does, instead of running the Mac
 *  browser widget's own copy, cut and paste. Text fields keep the native commands. True when the key was taken. */
bool JsgbMacSendClipboardKeyToPage(const FKeyEvent& Event);
#endif
