// window.alert, confirm and prompt as a Mac app shows them: a native alert on the page's window that the page's
// JavaScript waits for, as it waits for a browser's (Runtime/src/dialogs.ts). The page's thread waits while the main
// thread runs the alert, the way the engine's own file dialogs wait (DesktopPlatformMac.cpp): MainThreadReturn keeps the
// waiting thread answering what the main thread asks of it meanwhile, so neither waits on the other for ever.
#include "JsgbSystem.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#include "Apple/ScopeAutoreleasePool.h"
#include "Mac/MacApplication.h"
#include "Mac/CocoaThread.h"
#include "HAL/ThreadHeartBeat.h"
#import <AppKit/AppKit.h>

/** The prompt's text field. The app's menu has no Edit menu, so Cmd+X, C, V and A would do nothing in it: they go to the
 *  field's editor here, as in any other Mac text field. */
@interface FJsgbPromptField : NSTextField
@end

@implementation FJsgbPromptField
- (BOOL)performKeyEquivalent:(NSEvent*)Event
{
	const NSEventModifierFlags Mods = Event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
	if (Mods == NSEventModifierFlagCommand)
	{
		NSString* Key = Event.charactersIgnoringModifiers.lowercaseString;
		SEL Action = [Key isEqualToString:@"x"] ? @selector(cut:) : [Key isEqualToString:@"c"] ? @selector(copy:)
			: [Key isEqualToString:@"v"] ? @selector(paste:) : [Key isEqualToString:@"a"] ? @selector(selectAll:) : nullptr;
		if (Action != nullptr && [NSApp sendAction:Action to:nil from:self]) { return YES; }
	}
	return [super performKeyEquivalent:Event];
}
@end

namespace
{
	/** The window the page is in. The alert opens as its sheet, so it stays on that window, in its space and above it:
	 *  in full screen the engine raises the game's window above everything (MacWindow.cpp, UpdateFullScreenState), where
	 *  an alert of its own would open out of sight. A borderless window is never key or main, so the front window stands
	 *  in. Nil when no visible window can take a sheet. */
	NSWindow* SheetParent()
	{
		NSWindow* Window = [NSApp keyWindow] ?: [NSApp mainWindow];
		if (Window == nil || !Window.visible)
		{
			Window = nil;
			for (NSWindow* Candidate in [NSApp orderedWindows])
			{
				if (Candidate.visible && !Candidate.sheet && ![Candidate isKindOfClass:[NSPanel class]]) { Window = Candidate; break; }
			}
		}
		return Window != nil && Window.visible && !Window.miniaturized && Window.attachedSheet == nil ? Window : nil;
	}

	/** Builds the alert, runs it until the person answers and returns the button pressed. Main thread. */
	NSModalResponse RunAlert(const FString& Kind, const FString& Message, const FString& DefaultText, FString& OutText)
	{
		NSAlert* Alert = [[NSAlert alloc] init];
		Alert.messageText = Message.GetNSString();
		[Alert addButtonWithTitle:@"OK"];
		if (Kind != TEXT("alert"))
		{
			// Escape answers Cancel, as in a browser's dialog.
			[Alert addButtonWithTitle:@"Cancel"].keyEquivalent = @"\033";
		}
		FJsgbPromptField* Field = nil;
		if (Kind == TEXT("prompt"))
		{
			Field = [[FJsgbPromptField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
			Field.stringValue = DefaultText.GetNSString();
			Field.cell.usesSingleLineMode = YES;
			Field.cell.scrollable = YES;
			Field.cell.wraps = NO;
			Alert.accessoryView = Field;
			[Alert layout];
			// The field takes the keyboard with its text selected, so typing replaces the default.
			Alert.window.initialFirstResponder = Field;
		}
		NSModalResponse Response = NSAlertSecondButtonReturn;
		if (NSWindow* Parent = SheetParent())
		{
			[Alert beginSheetModalForWindow:Parent completionHandler:^(NSModalResponse Answer) { [NSApp stopModalWithCode:Answer]; }];
			Response = [NSApp runModalForWindow:Alert.window];
		}
		else
		{
			// On its own, above every window of the app, so a raised game window can't hide it.
			NSWindowLevel Level = NSModalPanelWindowLevel;
			for (NSWindow* Window in [NSApp windows]) { if (Window.visible && Window.level >= Level) { Level = Window.level + 1; } }
			Alert.window.level = Level;
			Response = [Alert runModal];
		}
		if (Field != nil) { OutText = FString(Field.stringValue); }
		[Field release];
		[Alert release];
		return Response;
	}
}

bool JsgbRunDialog(const FString& Kind, const FString& Message, const FString& DefaultText, FString& OutText)
{
	// The page's thread waits as long as the person takes; that is not a hang.
	FSlowHeartBeatScope SuspendHeartBeat;
	FDisableHitchDetectorScope SuspendHitchDetector;
	// Keys go to the alert: otherwise the engine keeps every key for its own windows (FMacApplication::HandleNSEvent).
	if (MacApplication != nullptr) { MacApplication->SystemModalMode(true); }
	__block FString Typed;
	const bool bOk = MainThreadReturn(^bool
	{
		SCOPED_AUTORELEASE_POOL;
		return RunAlert(Kind, Message, DefaultText, Typed) == NSAlertFirstButtonReturn;
	});
	if (MacApplication != nullptr)
	{
		MacApplication->SystemModalMode(false);
		// Modifier keys let go while the alert had the keyboard would otherwise still read as held.
		MacApplication->ResetModifierKeys();
	}
	OutText = Typed;
	return bOk;
}
#endif
