#pragma once

#include "CoreMinimal.h"

/** The files a person chose for the page: picked in the system's open panel or dropped on the window. Each one gets an
 *  id the page reads it by (Runtime/src/fileApi.ts), so the page can read only what the person chose, never a path it
 *  names itself. Thread-safe. */
struct FJsgbFiles
{
	/** Entries for chosen paths, as JSON [{id, name, size, modified, path, dir, top}]. bExpand lists every file inside a
	 *  chosen folder with its path from that folder's name (an <input webkitdirectory>); otherwise a folder is one entry
	 *  whose contents List gives. top is the index of the chosen path an entry came from. */
	static FString Describe(const TArray<FString>& Paths, bool bExpand);
	/** A chosen folder's own entries, one level, in name order (FileSystemDirectoryHandle, webkitGetAsEntry). */
	static FString List(int32 Id);
	/** Length bytes from Offset of a chosen file; false when Id is not one or the file can't be read that far. */
	static bool Read(int32 Id, int64 Offset, int32 Length, TArray<uint8>& Out);
	/** Open panel requests: Begin returns a request id, Finish stores the answer ({"files": [...]} or {"cancel": true}),
	 *  and Take hands it over once (false while the panel is still open). */
	static int32 Begin();
	static void Finish(int32 Request, const FString& Json);
	static bool Take(int32 Request, FString& OutJson);
	/** The files of the latest drop on the window, noted as they land; TakeDropped hands them over once. */
	static void SetDropped(const TArray<FString>& Paths);
	static FString TakeDropped();
};

/** Opens the system's open panel without blocking the game. OptionsJson: {multiple, directory, expand, extensions:
 *  ["glb", ...]} (no extensions: any file). Returns the request id for FJsgbFiles::Take, or 0 when this platform has no
 *  panel (JsgbOpenPanelMac.mm; other platforms answer 0 in JsgbFiles.cpp). */
int32 JsgbOpenFilePanel(const FString& OptionsJson);

#if PLATFORM_MAC
/** Notes the files of every drop on the overlay's web view as they land, for FJsgbFiles::TakeDropped. Safe to call
 *  often; it installs once (JsgbOpenPanelMac.mm). */
void JsgbWatchFileDrops();
#endif
