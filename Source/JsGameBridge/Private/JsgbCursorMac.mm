// The Mac cursor over the overlay has one writer: WebKit, which sets it from the page's CSS as a browser does
// (url() cursors, an I-beam over text and a hand over links included). Slate also sets the cursor, on every mouse move
// and whenever it is asked to look again, so JsgbCursor.cpp hands Slate the cursor WebKit already set and Slate's set
// changes nothing. Before, Slate set the keyword the overlay last reported (host-cursor packets), which reached the
// game thread a frame or more after WebKit had moved on and knew nothing of links or images, so the two writers
// flipped the cursor back and forth on each move.
//
// What Slate may be handed needs care (2026-11-17 crash): an image cursor (PrepViz's Direct Select arrow) is a
// transient object of WebKit's, replaced whenever the mirrored DOM is patched. Handing the live object over and
// having Slate set it every query both flickered (arrow, image, arrow... in the -JsgbLogCursor log) and finally
// set a freed cursor: SIGSEGV in -[NSCursor set] under FSlateUser::UpdateCursor. So an image cursor is copied
// once (image + hot spot) into one this file owns, the source is retained while it is the copied one, and while
// the page keeps asking for an image cursor the copy is handed back through WebKit's momentary resets to the
// arrow after a patch. System cursors are immortal singletons and pass through as they are.
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

	/** The system cursors are process-wide singletons: safe to hand to Slate as they are. */
	bool IsSystemCursor(NSCursor* C)
	{
		static NSCursor* System[] = {
			[NSCursor arrowCursor], [NSCursor IBeamCursor], [NSCursor IBeamCursorForVerticalLayout],
			[NSCursor pointingHandCursor], [NSCursor openHandCursor], [NSCursor closedHandCursor],
			[NSCursor crosshairCursor], [NSCursor operationNotAllowedCursor], [NSCursor disappearingItemCursor],
			[NSCursor resizeLeftCursor], [NSCursor resizeRightCursor], [NSCursor resizeLeftRightCursor],
			[NSCursor resizeUpCursor], [NSCursor resizeDownCursor], [NSCursor resizeUpDownCursor],
			[NSCursor dragLinkCursor], [NSCursor dragCopyCursor], [NSCursor contextualMenuCursor]};
		for (NSCursor* S : System) { if (C == S) { return true; } }
		return false;
	}

	// The image cursor last copied and its source, both retained. Game thread only (Slate's cursor query).
	NSCursor* HeldSource = nil;
	NSCursor* HeldCopy = nil;
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
	NSCursor* Answer = Shown;
	if (!Shown || IsSystemCursor(Shown))
	{
		// The page still wants its image cursor and WebKit only reset to the arrow for a patch: keep the copy.
		const bool bImageWanted = PageCursor.IsSet() && *PageCursor == EMouseCursor::Custom;
		if (bImageWanted && HeldCopy && Shown == [NSCursor arrowCursor]) { Answer = HeldCopy; }
	}
	else
	{
		if (Shown != HeldSource)
		{
			[HeldSource release];
			HeldSource = [Shown retain];
			[HeldCopy release];
			HeldCopy = [[NSCursor alloc] initWithImage:Shown.image hotSpot:Shown.hotSpot];
		}
		Answer = HeldCopy;
	}
	// Slate re-sets its cursor only when its type changes, so a WebKit reset to the arrow would otherwise
	// stay until the mouse next moves. Re-assert the answer here, on the frame it is queried.
	if (Answer && Shown != Answer) { [Answer set]; }
	return (void*)Answer;
}
#endif
