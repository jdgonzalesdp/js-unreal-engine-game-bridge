#pragma once

#include "CoreMinimal.h"
#include "GenericPlatform/ICursor.h"

class SWidget;
class UJsgbUIPort;

// The overlay page's mouse cursor in Unreal. The overlay (jsgb-ui-client.js) reports the CSS cursor under the mouse each
// time it changes, as {"type":"host-cursor","cursor":"<cursor>"}: the last keyword of the cursor list (auto already
// turned into text or default), or the whole list for an image cursor. The UI port keeps it (UJsgbUIPort::PageCursor)
// and Slate shows it over the overlay.

/** The Unreal cursor for a CSS cursor keyword (pointer, text, grab, ns-resize, ...); Default when none is close. */
EMouseCursor::Type JsgbCursorFromCss(const FString& Css);

/** Reads a host-cursor packet from the overlay. False when Json is any other packet. */
bool JsgbReadCursorPacket(const FString& Json, EMouseCursor::Type& OutCursor);

/** Makes Slate show the page's cursor over the overlay widget. On a Mac the engine's browser widget leaves the cursor to
 *  the game view behind it, which shows the arrow while the overlay has keyboard focus, so the arrow kept replacing the
 *  cursor WebKit set (pointer, text, grab, resize). Until the page reports a cursor, the widget leaves it to the view. */
void JsgbShowPageCursor(SWidget& Overlay, UJsgbUIPort* Port);

/** Has Slate ask for the cursor again now (game thread), so a new page cursor shows without waiting for the mouse to move. */
void JsgbRequeryCursor();

#if PLATFORM_MAC
/** The cursor the Mac shows now, which WebKit set from the page's CSS; null before any. Slate is handed it, so WebKit is
 *  the one writer (JsgbCursorMac.mm). With -JsgbLogCursor each change is logged with the page's reported cursor. */
void* JsgbMacShownCursor(TOptional<EMouseCursor::Type> PageCursor);
#endif
