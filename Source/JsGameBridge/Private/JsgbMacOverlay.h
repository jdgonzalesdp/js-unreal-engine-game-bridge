#pragma once

#if PLATFORM_MAC
struct FKeyEvent;

/** Mac: makes the UI overlay's native WKWebView draw no background of its own, and hides the Metal view the engine
 *  stacks above it (which holds only stale frames in a game window), so the game shows through. It also keeps the web
 *  view on the whole game view and gives it the keyboard while nothing else has it. Cheap and safe to call often: the
 *  engine creates the native views lazily and may replace them. */
void JsgbMakeMacWebViewsTransparent();

/** Mac: sends Cmd+C, Cmd+X or Cmd+V to the overlay page as a key press, as a browser does, instead of running the Mac
 *  browser widget's own copy, cut and paste. Text fields keep the native commands. True when the key was taken. */
bool JsgbMacSendClipboardKeyToPage(const FKeyEvent& Event);
#endif
