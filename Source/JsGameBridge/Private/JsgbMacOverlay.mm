#include "JsgbMacOverlay.h"

#if PLATFORM_MAC
#include "CoreMinimal.h"
// Before AppKit: renames Carbon's types that clash with Unreal's (FVector), as the engine's own Apple browser does.
#include "Mac/MacSystemIncludes.h"
#include "Mac/MacApplication.h"
#include "Mac/CocoaThread.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformTime.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

DEFINE_LOG_CATEGORY_STATIC(LogJsgbMacOverlay, Log, All);

// Unreal's WebBrowser on a Mac draws the UI overlay as a native WKWebView added to the game window's content view (the
// FMetalView the game draws into). For Slate drawn above the browser, the Metal RHI then stacks a second FMetalView
// over the web view (MetalViewport.cpp, CreateNativeLayer). In a game window the scene renders straight to the back
// buffer, and that second view only ever holds stale frames: the window shows the loading screen or black instead of
// the game. The overlay is the top of this host's UI, so nothing needs that view: it is hidden, and the web view draws
// no background of its own, so the game shows through.
namespace
{
	bool HoldsWebView(NSView* View)
	{
		if ([View isKindOfClass:[WKWebView class]]) { return true; }
		for (NSView* Child in View.subviews) { if ([Child isKindOfClass:[WKWebView class]]) { return true; } }
		return false;
	}

	int32 ClearWebViews(NSView* View)
	{
		int32 Count = 0;
		NSArray<NSView*>* Candidates = [View isKindOfClass:[WKWebView class]] ? @[View] : View.subviews;
		for (NSView* Child in Candidates)
		{
			if (![Child isKindOfClass:[WKWebView class]]) { continue; }
			WKWebView* Web = (WKWebView*)Child;
			NSNumber* Draws = [Web valueForKey:@"drawsBackground"];
			if (Draws == nil || [Draws boolValue])
			{
				[Web setValue:@NO forKey:@"drawsBackground"];
				if (@available(macOS 12.0, *)) { Web.underPageBackgroundColor = [NSColor clearColor]; }
				++Count;
			}
		}
		return Count;
	}

	WKWebView* FindWebView(NSView* View)
	{
		if ([View isKindOfClass:[WKWebView class]]) { return (WKWebView*)View; }
		for (NSView* Child in View.subviews) { if ([Child isKindOfClass:[WKWebView class]]) { return (WKWebView*)Child; } }
		return nil;
	}

	// The engine sizes the overlay's container from the Slate size divided by the window's backing scale, then adds the
	// title bar (ApplePlatformWebBrowser.cpp, UpdateFrameWithViewport). With high DPI mode off, Slate units are already
	// points, so a 1600x900 window got an 800x482 page in one corner and the rest of the window ignored the mouse. The
	// overlay is the whole game view: its container goes back on the whole content view and the web view on the whole
	// container. The page's innerWidth, innerHeight and devicePixelRatio then follow the window, as in a browser.
	void FillContent(NSView* Holder)
	{
		NSView* Content = Holder.superview;
		if (Content == nil) { return; }
		if (!NSEqualRects(Holder.frame, Content.bounds)) { Holder.frame = Content.bounds; }
		WKWebView* Web = FindWebView(Holder);
		if (Web != nil && Web != Holder && !NSEqualRects(Web.frame, Holder.bounds)) { Web.frame = Holder.bounds; }
	}
}

/** Puts the overlay's container back on the whole content view each time the engine moves or sizes it. The engine sets
 *  the container's frame and then sizes the web view to the container, so the web view never sees the small size. One
 *  watch per container, owned by it, so it goes when the engine replaces the container. */
@interface FJsgbOverlayFrameWatch : NSObject
- (void)frameChanged:(NSNotification*)Note;
@end

@implementation FJsgbOverlayFrameWatch
- (void)frameChanged:(NSNotification*)Note
{
	FillContent((NSView*)Note.object);
}
- (void)dealloc
{
	[[NSNotificationCenter defaultCenter] removeObserver:self];
	[super dealloc];
}
@end

namespace
{
	char GWatchKey = 0;

	/** Starts keeping Holder on the whole content view; true the first time for each container. */
	bool WatchContainer(NSView* Holder)
	{
		if (objc_getAssociatedObject(Holder, &GWatchKey) != nil) { return false; }
		FJsgbOverlayFrameWatch* Watch = [[FJsgbOverlayFrameWatch alloc] init];
		objc_setAssociatedObject(Holder, &GWatchKey, Watch, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
		[Watch release];
		// The container is small for a moment on each engine update; its web view must not follow it there and back.
		if (![Holder isKindOfClass:[WKWebView class]]) { Holder.autoresizesSubviews = NO; }
		Holder.postsFrameChangedNotifications = YES;
		[[NSNotificationCenter defaultCenter] addObserver:Watch selector:@selector(frameChanged:) name:NSViewFrameDidChangeNotification object:Holder];
		return true;
	}

	/** Keys reach the page only through the window's first responder: the engine re-sends each key there
	 *  (FWebBrowserWindow::RedirectNSEvent). Until the player clicked the overlay that was the window itself, so keys did
	 *  nothing at first. The web view takes the keyboard while nothing else in the window has it. */
	bool FocusWebView(NSWindow* Window, NSView* Content, NSView* Holder)
	{
		NSResponder* Current = Window.firstResponder;
		if (Current != nil && Current != Window && Current != Content) { return false; }
		WKWebView* Web = FindWebView(Holder);
		return Web != nil && !Web.hiddenOrHasHiddenAncestor && [Window makeFirstResponder:Web];
	}

	/** True when the overlay's keyboard focus is in editable text (a text field, a textarea or contenteditable). WebKit
	 *  offers to take and give back a string (the Services check) only then, answering from the page's editor state. */
	bool OverlayEditsText()
	{
		return MainThreadReturn<bool>(^bool
		{
			NSResponder* Responder = [NSApp keyWindow].firstResponder;
			// WebKit answers for the legacy string type ("NSStringPboardType"); for NSPasteboardTypeString it answers nil even
			// with a field focused.
			NSString* const Legacy = @"NSStringPboardType";
			return [Responder isKindOfClass:[WKWebView class]] && [Responder validRequestorForSendType:Legacy returnType:Legacy] == Responder;
		});
	}

	/** WebKit hands a key the page didn't cancel back to the app as the same NSEvent ([NSApp sendEvent:],
	 *  WebViewImpl::doneWithKeyEvent): Escape, Cmd+Z, Cmd+A or Cmd+S in a field. Unreal's monitor queued it for Slate
	 *  again, the browser widget re-sent it (ResendLastEvent), WebKit took it as a new key and the page saw it again, for
	 *  ever (Cmd+S kept saving). A monitor added after Unreal's runs before it: a key event it already passed once is
	 *  the hand-back, and it ends here, as it ends at the top of the responder chain in any other app. Main thread. */
	void StopKeyHandBacks()
	{
		static bool bInstalled = false;
		if (bInstalled) { return; }
		bInstalled = true;
		static NSMutableArray<NSEvent*>* Recent = [[NSMutableArray alloc] init];
		[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent*(NSEvent* Event)
		{
			if ([Recent indexOfObjectIdenticalTo:Event] != NSNotFound) { return nil; }
			[Recent addObject:Event];
			if (Recent.count > 16) { [Recent removeObjectAtIndex:0]; }
			return Event;
		}];
	}
}

void JsgbMakeMacWebViewsTransparent()
{
	dispatch_async(dispatch_get_main_queue(), ^
	{
		StopKeyHandBacks();
		int32 Cleared = 0, Hidden = 0;
		for (NSWindow* Window in [NSApp windows])
		{
			NSView* Content = Window.contentView;
			if (Content == nil) { continue; }
			bool bHasWebView = false;
			for (NSView* Child in Content.subviews)
			{
				if (!HoldsWebView(Child)) { continue; }
				bHasWebView = true;
				Cleared += ClearWebViews(Child);
				if (WatchContainer(Child)) { UE_LOG(LogJsgbMacOverlay, Display, TEXT("UI overlay: web view kept on the whole game view (%.0f x %.0f points)"), Content.bounds.size.width, Content.bounds.size.height); }
				FillContent(Child);
				if (FocusWebView(Window, Content, Child)) { UE_LOG(LogJsgbMacOverlay, Display, TEXT("UI overlay: web view has the keyboard")); }
			}
			if (!bHasWebView) { continue; }
			// The game's own view is the content view; any other view of its class sits above the web view.
			for (NSView* Child in Content.subviews)
			{
				if (Child != Content && [Child isKindOfClass:[Content class]] && !Child.hidden) { Child.hidden = YES; ++Hidden; }
			}
		}
		if (Cleared > 0 || Hidden > 0)
		{
			UE_LOG(LogJsgbMacOverlay, Display, TEXT("UI overlay: %d web view(s) made transparent, %d Metal layer view(s) above them hidden"), Cleared, Hidden);
		}
	});
}

bool JsgbMacSendClipboardKeyToPage(const FKeyEvent& Event)
{
	const FKey Key = Event.GetKey();
	// Slate on a Mac reports the Command key as Control and the Control key as Command (FMacApplication::GetModifierKeys).
	// So this is Cmd+C, Cmd+X or Cmd+V alone: the chords the Mac browser widget turns into its own copy, cut and paste
	// (ApplePlatformWebBrowser.cpp), so the page never saw them.
	if (!Event.IsControlDown() || Event.IsCommandDown() || Event.IsAltDown() || Event.IsShiftDown()) { return false; }
	if ((Key != EKeys::C && Key != EKeys::X && Key != EKeys::V) || !FSlateApplication::IsInitialized()) { return false; }
	// Held keys and text fields keep the browser's own copy, cut and paste. WebKit's hand-back of a key the page didn't
	// cancel never comes back here (StopKeyHandBacks).
	if (Event.IsRepeat() || OverlayEditsText()) { return false; }
	const TSharedPtr<GenericApplication> App = FSlateApplication::Get().GetPlatformApplication();
	if (!App.IsValid()) { return false; }
	// The key the engine is handling now goes to the window's first responder: the overlay's web view (FocusWebView).
	static_cast<FMacApplication*>(App.Get())->ResendLastEvent();
	return true;
}
#endif
