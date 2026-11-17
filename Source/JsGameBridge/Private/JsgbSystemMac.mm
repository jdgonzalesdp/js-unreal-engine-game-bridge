// The system's light or dark look and its time zone, for the page's prefers-color-scheme and local time zone
// (Runtime/src/appearance.ts, mediaQueries.ts, timeZones.ts).
#include "JsgbSystem.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#include "Apple/ScopeAutoreleasePool.h"
#include "Mac/CocoaThread.h"
#include "HAL/PlatformTime.h"
#include "Misc/ScopeLock.h"
#import <AppKit/AppKit.h>

namespace
{
	FCriticalSection GSchemeLock;
	/** The look last read, and when a fresh read was last asked for (FPlatformTime seconds). */
	FString GScheme;
	double GSchemeAsked = 0.0;

	/** The app's look now. It follows System Settings unless the app sets its own. Main thread. */
	FString ReadScheme()
	{
		NSAppearance* Look = NSApp != nil ? NSApp.effectiveAppearance : [NSAppearance currentDrawingAppearance];
		NSAppearanceName Match = [Look bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
		return [Match isEqualToString:NSAppearanceNameDarkAqua] ? FString(TEXT("dark")) : FString(TEXT("light"));
	}
}

FString JsgbColorScheme()
{
	FString Scheme;
	bool bFirst = false, bRefresh = false;
	{
		FScopeLock Lock(&GSchemeLock);
		const double Now = FPlatformTime::Seconds();
		bFirst = GScheme.IsEmpty();
		bRefresh = !bFirst && Now - GSchemeAsked > 1.0;
		if (bRefresh) { GSchemeAsked = Now; }
		Scheme = GScheme;
	}
	if (bFirst)
	{
		// Once, waiting for the main thread; after that the page reads the copy kept here.
		Scheme = MainThreadReturn(^FString { SCOPED_AUTORELEASE_POOL; return ReadScheme(); });
		FScopeLock Lock(&GSchemeLock);
		GScheme = Scheme;
		GSchemeAsked = FPlatformTime::Seconds();
	}
	else if (bRefresh)
	{
		// A change in System Settings reaches the copy within a second or two of the page looking, without the page ever
		// waiting for the main thread.
		dispatch_async(dispatch_get_main_queue(), ^
		{
			SCOPED_AUTORELEASE_POOL;
			const FString Fresh = ReadScheme();
			FScopeLock Lock(&GSchemeLock);
			GScheme = Fresh;
		});
	}
	return Scheme;
}

FString JsgbTimeZoneName()
{
	SCOPED_AUTORELEASE_POOL;
	// The zone set in System Settings now, not the one this process started with.
	[NSTimeZone resetSystemTimeZone];
	NSString* Name = [NSTimeZone systemTimeZone].name;
	return Name != nil ? FString(Name) : FString();
}
#endif
