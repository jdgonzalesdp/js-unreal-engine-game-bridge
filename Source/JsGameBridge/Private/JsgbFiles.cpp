// Files the person chose for the page, by id: what the open panel and drops hand the page (Runtime/src/fileApi.ts,
// filePicker.ts, dragDrop.ts), and the UJsgbBridge functions the page reads them through. The platform part (the open
// panel, and noting dropped files) is JsgbOpenPanelMac.mm.
#include "JsgbFiles.h"
#include "JsgbBridge.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Serialization/Archive.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	FCriticalSection GLock;
	/** Chosen file or folder id -> absolute path. */
	TMap<int32, FString> GGranted;
	/** Open panel request -> its answer, once the panel closed. */
	TMap<int32, FString> GAnswers;
	FString GDropped;
	int32 GNextFile = 1, GNextRequest = 1;
	/** A folder with more files than this lists the first ones (a whole disk chosen by mistake must not stall). */
	constexpr int32 MaxListed = 20000;

	int32 Grant(const FString& Path)
	{
		FScopeLock Lock(&GLock);
		const int32 Id = GNextFile++;
		GGranted.Add(Id, Path);
		return Id;
	}

	FString PathOf(int32 Id)
	{
		FScopeLock Lock(&GLock);
		const FString* Path = GGranted.Find(Id);
		return Path ? *Path : FString();
	}

	TSharedPtr<FJsonValue> Entry(const FString& Path, const FFileStatData& Stat, const FString& Relative, int32 Top)
	{
		const TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetNumberField(TEXT("id"), Grant(Path));
		O->SetStringField(TEXT("name"), FPaths::GetCleanFilename(Path));
		O->SetNumberField(TEXT("size"), Stat.bIsDirectory ? 0.0 : static_cast<double>(FMath::Max<int64>(Stat.FileSize, 0)));
		const bool bKnown = Stat.ModificationTime > FDateTime(1970, 1, 1);
		O->SetNumberField(TEXT("modified"), bKnown ? (Stat.ModificationTime - FDateTime(1970, 1, 1)).GetTotalMilliseconds() : 0.0);
		if (!Relative.IsEmpty()) { O->SetStringField(TEXT("path"), Relative); }
		if (Stat.bIsDirectory) { O->SetBoolField(TEXT("dir"), true); }
		O->SetNumberField(TEXT("top"), Top);
		return MakeShared<FJsonValueObject>(O);
	}

	FString ToJson(const TArray<TSharedPtr<FJsonValue>>& Items)
	{
		FString Out;
		const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(Items, Writer);
		return Out;
	}

	/** Hidden files (".DS_Store", ".git/...") stay out of a folder's listing, as the Finder shows it. */
	bool IsHidden(const FString& Relative) { return Relative.StartsWith(TEXT(".")) || Relative.Contains(TEXT("/.")); }

	struct FFound { FString Full, Relative; FFileStatData Stat; };

	/** The files deeply inside Folder (bRecursive), or its own files and folders, sorted by path, hidden ones left out. */
	TArray<FFound> Inside(const FString& Folder, bool bRecursive)
	{
		TArray<FFound> Found;
		const FString Prefix = Folder / TEXT("");
		auto Visit = [&Found, &Prefix, bRecursive](const TCHAR* Name, const FFileStatData& Stat)
		{
			const FString Full(Name);
			const FString Relative = Full.StartsWith(Prefix) ? Full.Mid(Prefix.Len()) : FPaths::GetCleanFilename(Full);
			if (IsHidden(Relative) || (bRecursive && Stat.bIsDirectory)) { return true; }
			Found.Add(FFound{Full, Relative, Stat});
			return Found.Num() < MaxListed;
		};
		if (bRecursive) { IFileManager::Get().IterateDirectoryStatRecursively(*Folder, Visit); }
		else { IFileManager::Get().IterateDirectoryStat(*Folder, Visit); }
		Found.Sort([](const FFound& A, const FFound& B) { return A.Relative < B.Relative; });
		return Found;
	}
}

FString FJsgbFiles::Describe(const TArray<FString>& Paths, bool bExpand)
{
	TArray<TSharedPtr<FJsonValue>> Items;
	for (int32 Top = 0; Top < Paths.Num(); ++Top)
	{
		FString Path = FPaths::RemoveDuplicateSlashes(Paths[Top]);
		while (Path.Len() > 1 && Path.EndsWith(TEXT("/"))) { Path.LeftChopInline(1); }
		const FFileStatData Stat = IFileManager::Get().GetStatData(*Path);
		if (!Stat.bIsValid) { continue; }
		if (!Stat.bIsDirectory || !bExpand) { Items.Add(Entry(Path, Stat, FString(), Top)); continue; }
		// webkitRelativePath starts at the chosen folder's own name: "Set/props/chair.glb".
		const FString Folder = FPaths::GetCleanFilename(Path);
		for (const FFound& File : Inside(Path, true)) { Items.Add(Entry(File.Full, File.Stat, Folder / File.Relative, Top)); }
	}
	return ToJson(Items);
}

FString FJsgbFiles::List(int32 Id)
{
	const FString Folder = PathOf(Id);
	TArray<TSharedPtr<FJsonValue>> Items;
	if (!Folder.IsEmpty() && IFileManager::Get().DirectoryExists(*Folder))
	{
		for (const FFound& Child : Inside(Folder, false)) { Items.Add(Entry(Child.Full, Child.Stat, FString(), 0)); }
	}
	return ToJson(Items);
}

bool FJsgbFiles::Read(int32 Id, int64 Offset, int32 Length, TArray<uint8>& Out)
{
	const FString Path = PathOf(Id);
	if (Path.IsEmpty() || Offset < 0 || Length < 0) { return false; }
	const TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*Path, FILEREAD_Silent));
	if (!Reader || Offset + Length > Reader->TotalSize()) { return false; }
	Out.SetNumUninitialized(Length);
	Reader->Seek(Offset);
	Reader->Serialize(Out.GetData(), Length);
	if (Reader->IsError()) { Out.Reset(); return false; }
	return true;
}

int32 FJsgbFiles::Begin()
{
	FScopeLock Lock(&GLock);
	return GNextRequest++;
}

void FJsgbFiles::Finish(int32 Request, const FString& Json)
{
	FScopeLock Lock(&GLock);
	GAnswers.Add(Request, Json);
}

bool FJsgbFiles::Take(int32 Request, FString& OutJson)
{
	FScopeLock Lock(&GLock);
	return GAnswers.RemoveAndCopyValue(Request, OutJson);
}

void FJsgbFiles::SetDropped(const TArray<FString>& Paths)
{
	const FString Json = Describe(Paths, false);
	FScopeLock Lock(&GLock);
	GDropped = Json;
}

FString FJsgbFiles::TakeDropped()
{
	FScopeLock Lock(&GLock);
	FString Json = MoveTemp(GDropped);
	GDropped.Reset();
	return Json.IsEmpty() ? FString(TEXT("[]")) : Json;
}

#if !PLATFORM_MAC
int32 JsgbOpenFilePanel(const FString& OptionsJson) { return 0; }
#endif

// The page's side (JavaScript/jsgb-main.js maps these onto __jsgbHost.files).
int32 UJsgbBridge::FilePickOpen(const FString& OptionsJson) { return JsgbOpenFilePanel(OptionsJson); }
FString UJsgbBridge::FilePickTake(int32 Request) { FString Json; return FJsgbFiles::Take(Request, Json) ? Json : FString(); }
FString UJsgbBridge::PickedFolderList(int32 Id) { return FJsgbFiles::List(Id); }
FString UJsgbBridge::DroppedFiles() { return FJsgbFiles::TakeDropped(); }
FArrayBufferValue UJsgbBridge::PickedFileRead(int32 Id, double Offset, int32 Length)
{
	FArrayBufferValue Out;
	FJsgbFiles::Read(Id, static_cast<int64>(Offset), Length, Out.Data);
	return Out;
}
