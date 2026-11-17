// The macOS open panel for <input type=file>, showOpenFilePicker and showDirectoryPicker (Runtime/src/filePicker.ts),
// and the files of a drop on the overlay's web view (Runtime/src/dragDrop.ts). The panel opens on the main thread
// without blocking the game, as the save panel does (JsgbSavePanelMac.mm), and the page polls for the answer
// (JsgbFiles.cpp).
#include "JsgbFiles.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

namespace
{
	FString PathOf(NSURL* Url)
	{
		const char* Path = Url.isFileURL ? Url.path.UTF8String : nullptr;
		return Path ? FString(UTF8_TO_TCHAR(Path)) : FString();
	}

	/** WKWebView's own performDragOperation:, which the drop watch calls on. */
	IMP GPerformDrag = nullptr;

	/** A drop on a web view: its files are noted before WebKit hands the drop to the page, so they are there when the
	 *  overlay page reports the drop to the game. */
	BOOL PerformDragOperation(id Self, SEL Selector, id<NSDraggingInfo> Info)
	{
		NSArray<NSURL*>* Urls = [[Info draggingPasteboard] readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
		if (Urls.count > 0)
		{
			TArray<FString> Paths;
			for (NSURL* Url in Urls) { const FString Path = PathOf(Url); if (!Path.IsEmpty()) { Paths.Add(Path); } }
			FJsgbFiles::SetDropped(Paths);
		}
		return GPerformDrag ? reinterpret_cast<BOOL (*)(id, SEL, id)>(GPerformDrag)(Self, Selector, Info) : NO;
	}
}

int32 JsgbOpenFilePanel(const FString& OptionsJson)
{
	TSharedPtr<FJsonObject> In;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(OptionsJson);
	if (!FJsonSerializer::Deserialize(Reader, In) || !In.IsValid()) { In = MakeShared<FJsonObject>(); }
	bool bMultiple = false, bDirectory = false, bExpand = false;
	In->TryGetBoolField(TEXT("multiple"), bMultiple);
	In->TryGetBoolField(TEXT("directory"), bDirectory);
	In->TryGetBoolField(TEXT("expand"), bExpand);
	NSMutableArray<NSString*>* Types = [[NSMutableArray alloc] init];
	const TArray<TSharedPtr<FJsonValue>>* Extensions = nullptr;
	if (In->TryGetArrayField(TEXT("extensions"), Extensions))
	{
		for (const TSharedPtr<FJsonValue>& Ext : *Extensions)
		{
			const FString Text = Ext.IsValid() ? Ext->AsString() : FString();
			if (!Text.IsEmpty()) { [Types addObject:[NSString stringWithUTF8String:TCHAR_TO_UTF8(*Text)]]; }
		}
	}
	const int32 Request = FJsgbFiles::Begin();
	dispatch_async(dispatch_get_main_queue(), ^
	{
		NSOpenPanel* Panel = [NSOpenPanel openPanel];
		Panel.canChooseFiles = !bDirectory;
		Panel.canChooseDirectories = bDirectory;
		Panel.allowsMultipleSelection = bMultiple;
		Panel.resolvesAliases = YES;
		Panel.canCreateDirectories = NO;
		if (!bDirectory && Types.count > 0)
		{
			// The extension list works on every macOS this engine supports, without the UniformTypeIdentifiers framework.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
			Panel.allowedFileTypes = Types;
#pragma clang diagnostic pop
		}
		[NSApp activateIgnoringOtherApps:YES];
		[Panel beginWithCompletionHandler:^(NSModalResponse Result)
		{
			TArray<FString> Paths;
			if (Result == NSModalResponseOK) { for (NSURL* Url in Panel.URLs) { const FString Path = PathOf(Url); if (!Path.IsEmpty()) { Paths.Add(Path); } } }
			// A chosen folder's files are listed off the main thread: a large folder takes a moment.
			dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^
			{
				FJsgbFiles::Finish(Request, Paths.Num() > 0 ? TEXT("{\"files\":") + FJsgbFiles::Describe(Paths, bExpand) + TEXT("}") : FString(TEXT("{\"cancel\":true}")));
			});
		}];
#if !__has_feature(objc_arc)
		[Types release];
#endif
	});
	return Request;
}

void JsgbWatchFileDrops()
{
	dispatch_async(dispatch_get_main_queue(), ^
	{
		static bool bInstalled = false;
		if (bInstalled) { return; }
		bInstalled = true;
		const SEL Selector = @selector(performDragOperation:);
		const Method Existing = class_getInstanceMethod([WKWebView class], Selector);
		if (Existing == nullptr) { return; }
		GPerformDrag = method_getImplementation(Existing);
		// WKWebView's own method when it has one; otherwise one of its own that calls the inherited one.
		if (!class_addMethod([WKWebView class], Selector, reinterpret_cast<IMP>(&PerformDragOperation), method_getTypeEncoding(Existing)))
		{
			method_setImplementation(Existing, reinterpret_cast<IMP>(&PerformDragOperation));
		}
	});
}
#endif
