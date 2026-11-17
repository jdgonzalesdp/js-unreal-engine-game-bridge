// The Mac cursor over the overlay has one writer: WebKit, which sets it from the page's CSS as a browser does
// (url() cursors, an I-beam over text and a hand over links included). Slate also sets the cursor, on every mouse move
// and whenever it is asked to look again, so JsgbCursor.cpp hands Slate the cursor WebKit already set and Slate's set
// changes nothing. Before, Slate set the keyword the overlay last reported (host-cursor packets), which reached the
// game thread a frame or more after WebKit had moved on and knew nothing of links or images, so the two writers
// flipped the cursor back and forth on each move.
#include "JsgbCursor.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#import <AppKit/AppKit.h>

DEFINE_LOG_CATEGORY_STATIC(LogJsgbCursor, Log, All);

namespace
{
	/** A short name for a system cursor, for the -JsgbLogCursor log. */
	const TCHAR* CursorName(NSCursor* C)
	{
		if (!C) { return TEXT("none"); }
		if (C == [NSCursor arrowCursor]) { return TEXT("arrow"); }
		if (C == [NSCursor pointingHandCursor]) { return TEXT("pointing hand"); }
		if (C == [NSCursor openHandCursor]) { return TEXT("open hand"); }
		if (C == [NSCursor closedHandCursor]) { return TEXT("closed hand"); }
		if (C == [NSCursor IBeamCursor]) { return TEXT("I-beam"); }
		if (C == [NSCursor crosshairCursor]) { return TEXT("crosshair"); }
		if (C == [NSCursor operationNotAllowedCursor]) { return TEXT("not allowed"); }
		if (C == [NSCursor resizeLeftRightCursor] || C == [NSCursor resizeUpDownCursor]) { return TEXT("resize"); }
		return TEXT("other (an image cursor)");
	}
}

void* JsgbMacShownCursor(TOptional<EMouseCursor::Type> PageCursor)
{
	NSCursor* Shown = [NSCursor currentCursor];
	// -JsgbLogCursor: each change of the shown cursor, with the keyword the page last reported, so a cursor that still
	// changes without the page asking can be told apart.
	static const bool bLog = FParse::Param(FCommandLine::Get(), TEXT("JsgbLogCursor"));
	static NSCursor* Last = nil;
	if (bLog && Shown != Last)
	{
		UE_LOG(LogJsgbCursor, Display, TEXT("cursor now %s (page reported %d)"), CursorName(Shown), PageCursor.IsSet() ? static_cast<int32>(*PageCursor) : -1);
		Last = Shown;
	}
	return (void*)Shown;
}
#endif
