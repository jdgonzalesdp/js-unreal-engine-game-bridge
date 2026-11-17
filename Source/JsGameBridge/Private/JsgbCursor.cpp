#include "JsgbCursor.h"
#include "JsgbHost.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Framework/Application/SlateApplication.h"
#include "Widgets/SWidget.h"

EMouseCursor::Type JsgbCursorFromCss(const FString& Css)
{
	// A cursor list ("url(hand.png) 4 4, pointer") falls back to its last keyword, as a browser does without the image.
	FString Name = Css;
	int32 Comma = INDEX_NONE;
	if (Name.FindLastChar(TEXT(','), Comma)) { Name = Name.Mid(Comma + 1); }
	Name = Name.TrimStartAndEnd().ToLower();
	static const TMap<FString, EMouseCursor::Type> Map = {
		{TEXT("none"), EMouseCursor::None}, {TEXT("pointer"), EMouseCursor::Hand},
		{TEXT("text"), EMouseCursor::TextEditBeam}, {TEXT("vertical-text"), EMouseCursor::TextEditBeam},
		{TEXT("grab"), EMouseCursor::GrabHand}, {TEXT("-webkit-grab"), EMouseCursor::GrabHand},
		{TEXT("grabbing"), EMouseCursor::GrabHandClosed}, {TEXT("-webkit-grabbing"), EMouseCursor::GrabHandClosed},
		{TEXT("crosshair"), EMouseCursor::Crosshairs}, {TEXT("move"), EMouseCursor::CardinalCross}, {TEXT("all-scroll"), EMouseCursor::CardinalCross},
		{TEXT("ew-resize"), EMouseCursor::ResizeLeftRight}, {TEXT("col-resize"), EMouseCursor::ResizeLeftRight},
		{TEXT("e-resize"), EMouseCursor::ResizeLeftRight}, {TEXT("w-resize"), EMouseCursor::ResizeLeftRight},
		{TEXT("ns-resize"), EMouseCursor::ResizeUpDown}, {TEXT("row-resize"), EMouseCursor::ResizeUpDown},
		{TEXT("n-resize"), EMouseCursor::ResizeUpDown}, {TEXT("s-resize"), EMouseCursor::ResizeUpDown},
		{TEXT("nwse-resize"), EMouseCursor::ResizeSouthEast}, {TEXT("nw-resize"), EMouseCursor::ResizeSouthEast}, {TEXT("se-resize"), EMouseCursor::ResizeSouthEast},
		{TEXT("nesw-resize"), EMouseCursor::ResizeSouthWest}, {TEXT("ne-resize"), EMouseCursor::ResizeSouthWest}, {TEXT("sw-resize"), EMouseCursor::ResizeSouthWest},
		{TEXT("not-allowed"), EMouseCursor::SlashedCircle}, {TEXT("no-drop"), EMouseCursor::SlashedCircle}};
	const EMouseCursor::Type* Found = Map.Find(Name);
	return Found ? *Found : EMouseCursor::Default;
}

bool JsgbReadCursorPacket(const FString& Json, EMouseCursor::Type& OutCursor)
{
	if (!Json.StartsWith(TEXT("{\"type\":\"host-cursor\""))) { return false; }
	FString Css;
	TSharedPtr<FJsonObject> Packet;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	if (FJsonSerializer::Deserialize(Reader, Packet) && Packet.IsValid()) { Packet->TryGetStringField(TEXT("cursor"), Css); }
	OutCursor = JsgbCursorFromCss(Css);
	return true;
}

void JsgbShowPageCursor(SWidget& Overlay, UJsgbUIPort* Port)
{
	// Slate asks the widgets under the mouse (or the one holding the mouse during a drag) from the innermost out, and the
	// first answer wins. The browser's own widget gives none, so this one answers before the game view behind it.
	const TWeakObjectPtr<UJsgbUIPort> WeakPort(Port);
	Overlay.SetCursor(TAttribute<TOptional<EMouseCursor::Type>>::CreateLambda([WeakPort]() -> TOptional<EMouseCursor::Type>
	{
		const UJsgbUIPort* P = WeakPort.Get();
#if PLATFORM_MAC
		// One writer: Slate gets the cursor WebKit already set, so its own set on each mouse move changes nothing.
		// Answering with the reported keyword fought WebKit whenever the two differed (JsgbCursorMac.mm).
		if (void* Shown = JsgbMacShownCursor(P ? P->PageCursor : TOptional<EMouseCursor::Type>()))
		{
			if (FSlateApplication::IsInitialized())
			{
				if (const TSharedPtr<ICursor> Cursor = FSlateApplication::Get().GetPlatformCursor()) { Cursor->SetTypeShape(EMouseCursor::Custom, Shown); return EMouseCursor::Custom; }
			}
		}
#endif
		return P ? P->PageCursor : TOptional<EMouseCursor::Type>();
	}));
}

void JsgbRequeryCursor()
{
	if (FSlateApplication::IsInitialized()) { FSlateApplication::Get().QueryCursor(); }
}
