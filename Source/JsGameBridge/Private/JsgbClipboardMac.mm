// The clipboard as a Mac browser uses it (Runtime/src/clipboard.ts): text, HTML and pictures on the general pasteboard,
// and files copied in the Finder. The engine also reads and writes the pasteboard on the calling thread
// (MacPlatformApplicationMisc.cpp, ClipboardCopy).
#include "JsgbSystem.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#include "Apple/ScopeAutoreleasePool.h"
#include "JsgbFiles.h"
#import <AppKit/AppKit.h>

namespace
{
	/** The pasteboard type a web type is kept as; nil for a type the clipboard doesn't carry. */
	NSPasteboardType PasteboardType(const FString& WebType)
	{
		if (WebType == TEXT("text/plain")) { return NSPasteboardTypeString; }
		if (WebType == TEXT("text/html")) { return NSPasteboardTypeHTML; }
		if (WebType == TEXT("text/uri-list")) { return NSPasteboardTypeURL; }
		return nil;
	}

	/** Paths of the files copied in the Finder. */
	TArray<FString> CopiedFiles(NSPasteboard* Board)
	{
		TArray<FString> Paths;
		NSArray<NSURL*>* Urls = [Board readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
		for (NSURL* Url in Urls)
		{
			const char* Path = Url.isFileURL ? Url.path.UTF8String : nullptr;
			if (Path != nullptr) { Paths.Add(FString(UTF8_TO_TCHAR(Path))); }
		}
		return Paths;
	}

	/** The pasteboard's picture as PNG: PNG as it is, TIFF (Preview, a copied image) converted. Only these two count
	 *  as a picture, as in a Mac browser: text copied from a document often carries a PDF of itself, which must not turn
	 *  a text paste into a picture. */
	NSData* PictureAsPng(NSPasteboard* Board)
	{
		if (NSData* Png = [Board dataForType:NSPasteboardTypePNG]) { return Png; }
		NSData* Tiff = [Board dataForType:NSPasteboardTypeTIFF];
		NSBitmapImageRep* Rep = Tiff != nil ? [NSBitmapImageRep imageRepWithData:Tiff] : nil;
		return Rep != nil ? [Rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
	}
}

FString JsgbClipboardTypes()
{
	SCOPED_AUTORELEASE_POOL;
	NSPasteboard* Board = [NSPasteboard generalPasteboard];
	NSArray<NSPasteboardType>* Types = Board.types;
	const bool bFiles = [Board canReadObjectForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
	TArray<FString> Out;
	if ([Types containsObject:NSPasteboardTypeString]) { Out.Add(TEXT("\"text/plain\"")); }
	if ([Types containsObject:NSPasteboardTypeHTML]) { Out.Add(TEXT("\"text/html\"")); }
	// Copied files carry their icons as pictures; a browser offers the files themselves.
	if (!bFiles && ([Types containsObject:NSPasteboardTypePNG] || [Types containsObject:NSPasteboardTypeTIFF])) { Out.Add(TEXT("\"image/png\"")); }
	if (bFiles) { Out.Add(TEXT("\"Files\"")); }
	return TEXT("[") + FString::Join(Out, TEXT(",")) + TEXT("]");
}

FString JsgbClipboardString(const FString& Type)
{
	SCOPED_AUTORELEASE_POOL;
	NSPasteboardType Kind = PasteboardType(Type);
	NSString* Text = Kind != nil ? [[NSPasteboard generalPasteboard] stringForType:Kind] : nil;
	return Text != nil ? FString(Text) : FString();
}

bool JsgbClipboardPng(TArray<uint8>& OutPng)
{
	SCOPED_AUTORELEASE_POOL;
	OutPng.Reset();
	NSPasteboard* Board = [NSPasteboard generalPasteboard];
	if (CopiedFiles(Board).Num() > 0) { return false; }
	NSData* Png = PictureAsPng(Board);
	if (Png == nil || Png.length == 0) { return false; }
	OutPng.Append(static_cast<const uint8*>(Png.bytes), static_cast<int32>(Png.length));
	return true;
}

FString JsgbClipboardFiles()
{
	SCOPED_AUTORELEASE_POOL;
	const TArray<FString> Paths = CopiedFiles([NSPasteboard generalPasteboard]);
	return Paths.Num() > 0 ? FJsgbFiles::Describe(Paths, false) : FString(TEXT("[]"));
}

bool JsgbClipboardWrite(const TMap<FString, FString>& Texts, const TArray<uint8>& Png)
{
	SCOPED_AUTORELEASE_POOL;
	NSPasteboardItem* Item = [[[NSPasteboardItem alloc] init] autorelease];
	bool bAny = false;
	for (const TPair<FString, FString>& Text : Texts)
	{
		NSPasteboardType Kind = PasteboardType(Text.Key);
		if (Kind != nil && [Item setString:Text.Value.GetNSString() forType:Kind]) { bAny = true; }
	}
	if (Png.Num() > 0 && [Item setData:[NSData dataWithBytes:Png.GetData() length:Png.Num()] forType:NSPasteboardTypePNG]) { bAny = true; }
	if (!bAny) { return false; }
	NSPasteboard* Board = [NSPasteboard generalPasteboard];
	[Board clearContents];
	return [Board writeObjects:@[Item]];
}
#endif
