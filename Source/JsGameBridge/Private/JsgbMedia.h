#pragma once

#include "CoreMinimal.h"

/** Exports for the page (Runtime/src/media.ts): saved files, downloads and H.264 video. UJsgbBridge's media functions
 *  (JsgbMedia.cpp) answer the page; the platform parts are JsgbSavePanelMac.mm and JsgbVideoEncodeMac.mm. */

/** The user's Downloads folder. */
FString JsgbDownloadsDir();
/** A file name the page asked for, without folders or characters a file system refuses ("download" when nothing is left). */
FString JsgbCleanName(const FString& Name);
/** A path in Dir for Name that no file has yet: "name (1).ext" and so on when it is taken. */
FString JsgbFreePath(const FString& Dir, const FString& Name);
/** A save dialog finished: the chosen path, or empty when it was cancelled. Any thread. */
void JsgbSaveResolved(int32 Id, const FString& Path);
#if PLATFORM_MAC
/** Opens the system save panel without blocking the game, and calls JsgbSaveResolved when it closes. */
void JsgbOpenSavePanel(int32 Id, const FString& SuggestedName);
#endif

/** H.264 sessions: Open returns an id (0 when this platform can't encode that size). Encode takes RGBA8 rows from the
 *  top. Take appends the description block and the finished chunks in the layout Runtime/src/webcodecs.ts reads. */
bool JsgbVideoSupported(int32 Width, int32 Height);
int32 JsgbVideoOpen(int32 Width, int32 Height, double Bitrate, double Fps);
bool JsgbVideoEncode(int32 Id, const uint8* Rgba, int32 Width, int32 Height, double TimestampUs, double DurationUs, bool bKey);
void JsgbVideoTake(int32 Id, TArray<uint8>& Out);
bool JsgbVideoFlush(int32 Id);
void JsgbVideoClose(int32 Id);
