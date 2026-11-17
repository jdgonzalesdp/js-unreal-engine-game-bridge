// The page's dialogs, clipboard, light or dark look and time zone through the bridge (JsgbSystem.h), and those services
// on platforms other than the Mac, which has its own (JsgbDialogsMac.mm, JsgbClipboardMac.mm, JsgbSystemMac.mm).
#include "JsgbSystem.h"
#include "JsgbBridge.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

FString UJsgbBridge::ShowDialog(const FString& Kind, const FString& Message, const FString& Value)
{
	const FString Shown = Kind == TEXT("confirm") || Kind == TEXT("prompt") ? Kind : FString(TEXT("alert"));
	// A scripted run has nobody to answer: -JsgbNoDialogs, or a run with a time limit (-JsgbMaxSeconds=, which
	// Tools/run-unreal.mjs and the shader preparation always pass). It goes on as before, OK for alert and confirm and
	// Cancel for prompt, and the log says so. -unattended alone doesn't count: the launches a person uses pass it too.
	FString Limit;
	if (FParse::Param(FCommandLine::Get(), TEXT("JsgbNoDialogs")) || FParse::Value(FCommandLine::Get(), TEXT("JsgbMaxSeconds="), Limit))
	{
		Log(TEXT("warn"), FString::Printf(TEXT("%s (scripted run, answered %s): %s"), *Shown, Shown == TEXT("prompt") ? TEXT("Cancel") : TEXT("OK"), *Message));
		return Shown == TEXT("prompt") ? TEXT("0") : TEXT("1");
	}
	FString Typed;
	const bool bOk = JsgbRunDialog(Shown, Message, Value, Typed);
	return (bOk ? TEXT("1") : TEXT("0")) + Typed;
}

FString UJsgbBridge::ClipboardTypes() { return JsgbClipboardTypes(); }
FString UJsgbBridge::ClipboardText(const FString& Type) { return JsgbClipboardString(Type); }
FString UJsgbBridge::ClipboardFiles() { return JsgbClipboardFiles(); }

FArrayBufferValue UJsgbBridge::ClipboardImage()
{
	FArrayBufferValue Out;
	JsgbClipboardPng(Out.Data);
	return Out;
}

bool UJsgbBridge::ClipboardWrite(const FString& TextsJson, FArrayBuffer Png)
{
	TMap<FString, FString> Texts;
	TSharedPtr<FJsonObject> In;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(TextsJson);
	if (FJsonSerializer::Deserialize(Reader, In) && In.IsValid())
	{
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : In->Values)
		{
			FString Text;
			if (Pair.Value.IsValid() && Pair.Value->TryGetString(Text)) { Texts.Add(Pair.Key, Text); }
		}
	}
	const TArray<uint8> Picture(static_cast<const uint8*>(Png.Data), static_cast<int32>(Png.Length));
	return JsgbClipboardWrite(Texts, Picture);
}

FString UJsgbBridge::ColorScheme() { return JsgbColorScheme(); }
FString UJsgbBridge::TimeZoneName() { return JsgbTimeZoneName(); }

#if !PLATFORM_MAC
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformMisc.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbSystem, Log, All);

bool JsgbRunDialog(const FString& Kind, const FString& Message, const FString& DefaultText, FString& OutText)
{
	// TODO(Windows): prompt needs a dialog with a text field. MessageBoxExt has only buttons, so a prompt answers Cancel
	// (null) here until there is one.
	if (Kind == TEXT("prompt"))
	{
		UE_LOG(LogJsgbSystem, Warning, TEXT("window.prompt has no native dialog on this platform yet; it answered Cancel: %s"), *Message);
		return false;
	}
	const bool bConfirm = Kind == TEXT("confirm");
	const EAppReturnType::Type Answer = FPlatformMisc::MessageBoxExt(bConfirm ? EAppMsgType::OkCancel : EAppMsgType::Ok, *Message, FApp::GetProjectName());
	return !bConfirm || Answer == EAppReturnType::Ok;
}

// TODO(Windows): HTML, pictures and copied files on the clipboard ("HTML Format", CF_DIB and CF_HDROP). Text works through
// the engine's own clipboard.
FString JsgbClipboardTypes()
{
	FString Text;
	FPlatformApplicationMisc::ClipboardPaste(Text);
	return Text.IsEmpty() ? FString(TEXT("[]")) : FString(TEXT("[\"text/plain\"]"));
}

FString JsgbClipboardString(const FString& Type)
{
	FString Text;
	if (Type == TEXT("text/plain")) { FPlatformApplicationMisc::ClipboardPaste(Text); }
	return Text;
}

bool JsgbClipboardPng(TArray<uint8>& OutPng) { OutPng.Reset(); return false; }
FString JsgbClipboardFiles() { return TEXT("[]"); }

bool JsgbClipboardWrite(const TMap<FString, FString>& Texts, const TArray<uint8>& Png)
{
	const FString* Text = Texts.Find(TEXT("text/plain"));
	if (Text == nullptr) { return false; }
	FPlatformApplicationMisc::ClipboardCopy(**Text);
	return true;
}

// TODO(Windows): the light or dark app mode (AppsUseLightTheme under HKCU\Software\Microsoft\Windows\CurrentVersion\
// Themes\Personalize). Empty leaves both schemes unmatched, as before.
FString JsgbColorScheme() { return FString(); }
FString JsgbTimeZoneName() { return FPlatformMisc::GetTimeZoneId(); }
#endif
