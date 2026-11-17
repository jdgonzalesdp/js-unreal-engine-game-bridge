// Exports for the page (Runtime/src/media.ts): image files, the save dialog, downloads and H.264 video. The page never
// names a path: it writes only the file the user chose in the save dialog, or a new file in Downloads.
#include "JsgbMedia.h"
#include "JsgbBridge.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FArrayBufferValue UJsgbBridge::EncodeImage(FArrayBuffer Rgba, int32 Width, int32 Height, const FString& Type, float Quality)
{
	FArrayBufferValue Out;
	if (Width < 1 || Height < 1 || Rgba.Length < static_cast<size_t>(Width) * Height * 4) { return Out; }
	const bool bJpeg = Type == TEXT("jpeg");
	IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(bJpeg ? EImageFormat::JPEG : EImageFormat::PNG);
	// A format the wrapper refuses answers empty, and the runtime encodes it in JavaScript instead.
	if (!Wrapper || !Wrapper->SetRaw(Rgba.Data, static_cast<int64>(Width) * Height * 4, Width, Height, ERGBFormat::RGBA, 8)) { return Out; }
	const TArray64<uint8>& Bytes = Wrapper->GetCompressed(bJpeg ? FMath::Clamp(FMath::RoundToInt(Quality * 100.f), 1, 100) : 0);
	Out.Data.Append(Bytes.GetData(), static_cast<int32>(Bytes.Num()));
	return Out;
}

FString JsgbDownloadsDir()
{
	const FString Home = FPlatformMisc::GetEnvironmentVariable(PLATFORM_WINDOWS ? TEXT("USERPROFILE") : TEXT("HOME"));
	const FString Dir = Home.IsEmpty() ? FPaths::ProjectSavedDir() / TEXT("Downloads") : Home / TEXT("Downloads");
	IFileManager::Get().MakeDirectory(*Dir, true);
	return Dir;
}

FString JsgbCleanName(const FString& Name)
{
	FString Clean = FPaths::GetCleanFilename(Name.Replace(TEXT("\\"), TEXT("/")));
	for (TCHAR& C : Clean) { if (C < 32 || FCString::Strchr(TEXT(":*?\"<>|"), C)) { C = TEXT('_'); } }
	Clean.TrimStartAndEndInline();
	while (Clean.StartsWith(TEXT("."))) { Clean.RightChopInline(1); }
	return Clean.IsEmpty() ? FString(TEXT("download")) : Clean;
}

FString JsgbFreePath(const FString& Dir, const FString& Name)
{
	FString Path = Dir / Name;
	const FString Base = FPaths::GetBaseFilename(Name), Ext = FPaths::GetExtension(Name, true);
	for (int32 N = 1; N < 1000 && IFileManager::Get().FileExists(*Path); ++N) { Path = Dir / FString::Printf(TEXT("%s (%d)%s"), *Base, N, *Ext); }
	return Path;
}

namespace
{
	struct FPick { FString Path; FString Answer; };
	FCriticalSection PickLock;
	TMap<int32, FPick> Picks;
	int32 NextPick = 0;

	TSharedPtr<FJsonObject> ParseObject(const FString& Json)
	{
		TSharedPtr<FJsonObject> Obj;
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Obj);
		return Obj;
	}
	bool WriteFile(const FString& Path, const FArrayBuffer& Bytes, bool bAppend)
	{
		const TArrayView<const uint8> View(static_cast<const uint8*>(Bytes.Data), static_cast<int32>(Bytes.Length));
		return FFileHelper::SaveArrayToFile(View, *Path, &IFileManager::Get(), bAppend ? FILEWRITE_Append : FILEWRITE_None);
	}
}

void JsgbSaveResolved(int32 Id, const FString& Path)
{
	FScopeLock Lock(&PickLock);
	if (FPick* P = Picks.Find(Id)) { P->Path = Path; P->Answer = Path.IsEmpty() ? FString(TEXT("cancel")) : TEXT("ok:") + FPaths::GetCleanFilename(Path); }
}

int32 UJsgbBridge::SavePick(const FString& Name, const FString& TypesJson)
{
	const FString Clean = JsgbCleanName(Name);
	int32 Id = 0;
	{ FScopeLock Lock(&PickLock); Id = ++NextPick; Picks.Add(Id, FPick()); }
#if PLATFORM_MAC
	JsgbOpenSavePanel(Id, Clean);
#else
	// TODO(Windows): the system save dialog (IFileSaveDialog). Until then the file goes into Downloads under a free name.
	JsgbSaveResolved(Id, JsgbFreePath(JsgbDownloadsDir(), Clean));
#endif
	return Id;
}

FString UJsgbBridge::SaveTake(int32 Id)
{
	FScopeLock Lock(&PickLock);
	const FPick* P = Picks.Find(Id);
	return P ? P->Answer : FString(TEXT("cancel"));
}

bool UJsgbBridge::SaveWrite(int32 Id, FArrayBuffer Bytes, bool bAppend)
{
	FString Path;
	{ FScopeLock Lock(&PickLock); const FPick* P = Picks.Find(Id); if (!P || P->Path.IsEmpty()) { return false; } Path = P->Path; }
	const bool bOk = WriteFile(Path, Bytes, bAppend);
	Log(bOk ? TEXT("log") : TEXT("error"), FString::Printf(TEXT("%s %s (%llu bytes)"), bOk ? TEXT("saved") : TEXT("could not save"), *Path, static_cast<uint64>(Bytes.Length)));
	return bOk;
}

FString UJsgbBridge::Download(const FString& Name, FArrayBuffer Bytes)
{
	const FString Path = JsgbFreePath(JsgbDownloadsDir(), JsgbCleanName(Name));
	if (!WriteFile(Path, Bytes, false)) { Log(TEXT("error"), FString::Printf(TEXT("could not save the download %s"), *Path)); return FString(); }
	Log(TEXT("log"), FString::Printf(TEXT("download saved: %s"), *Path));
	return FPaths::GetCleanFilename(Path);
}

bool UJsgbBridge::VideoSupported(const FString& Json)
{
	const TSharedPtr<FJsonObject> J = ParseObject(Json);
	return J && JsgbVideoSupported(static_cast<int32>(J->GetNumberField(TEXT("width"))), static_cast<int32>(J->GetNumberField(TEXT("height"))));
}

int32 UJsgbBridge::VideoOpen(const FString& Json)
{
	const TSharedPtr<FJsonObject> J = ParseObject(Json);
	if (!J) { return 0; }
	return JsgbVideoOpen(static_cast<int32>(J->GetNumberField(TEXT("width"))), static_cast<int32>(J->GetNumberField(TEXT("height"))), J->GetNumberField(TEXT("bitrate")), J->GetNumberField(TEXT("framerate")));
}

bool UJsgbBridge::VideoEncode(int32 Id, FArrayBuffer Rgba, int32 Width, int32 Height, double TimestampUs, double DurationUs, bool bKey)
{
	if (Width < 1 || Height < 1 || Rgba.Length < static_cast<size_t>(Width) * Height * 4) { return false; }
	return JsgbVideoEncode(Id, static_cast<const uint8*>(Rgba.Data), Width, Height, TimestampUs, DurationUs, bKey);
}

FArrayBufferValue UJsgbBridge::VideoTake(int32 Id) { FArrayBufferValue Out; JsgbVideoTake(Id, Out.Data); return Out; }
bool UJsgbBridge::VideoFlush(int32 Id) { return JsgbVideoFlush(Id); }
void UJsgbBridge::VideoClose(int32 Id) { JsgbVideoClose(Id); }

#if !PLATFORM_MAC
// TODO(Windows): H.264 through Media Foundation (IMFTransform, MFVideoFormat_H264), returning AVC chunks and the avcC
// record as JsgbVideoEncodeMac.mm does. Until then VideoEncoder says no codec is supported, as a browser without one does.
bool JsgbVideoSupported(int32, int32) { return false; }
int32 JsgbVideoOpen(int32, int32, double, double) { return 0; }
bool JsgbVideoEncode(int32, const uint8*, int32, int32, double, double, bool) { return false; }
void JsgbVideoTake(int32, TArray<uint8>&) {}
bool JsgbVideoFlush(int32) { return false; }
void JsgbVideoClose(int32) {}
#endif
