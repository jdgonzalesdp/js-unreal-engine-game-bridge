// The macOS save panel for window.showSaveFilePicker (Runtime/src/download.ts). It opens on the main thread without
// blocking the game, and the page polls for the answer (JsgbMedia.cpp).
#include "JsgbMedia.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#import <AppKit/AppKit.h>

void JsgbOpenSavePanel(int32 Id, const FString& SuggestedName)
{
	NSString* Name = [[NSString alloc] initWithUTF8String:TCHAR_TO_UTF8(*SuggestedName)];
	dispatch_async(dispatch_get_main_queue(), ^
	{
		NSSavePanel* Panel = [NSSavePanel savePanel];
		Panel.nameFieldStringValue = Name;
		Panel.canCreateDirectories = YES;
		Panel.extensionHidden = NO;
		Panel.directoryURL = [NSURL fileURLWithPath:[NSHomeDirectory() stringByAppendingPathComponent:@"Downloads"] isDirectory:YES];
		[NSApp activateIgnoringOtherApps:YES];
		[Panel beginWithCompletionHandler:^(NSModalResponse Result)
		{
			const char* Chosen = Result == NSModalResponseOK && Panel.URL ? Panel.URL.path.UTF8String : nullptr;
			JsgbSaveResolved(Id, Chosen ? FString(UTF8_TO_TCHAR(Chosen)) : FString());
		}];
#if !__has_feature(objc_arc)
		[Name release];
#endif
	});
}
#endif
