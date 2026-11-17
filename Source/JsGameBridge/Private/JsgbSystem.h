#pragma once

#include "CoreMinimal.h"

/** What a browser takes from the system for a page: its dialogs (window.alert, confirm and prompt), the clipboard
 *  (navigator.clipboard, copy and paste events), the light or dark look (prefers-color-scheme) and the time zone.
 *  UJsgbBridge hands them to the page (JsgbSystem.cpp; Runtime/src/dialogs.ts, clipboard.ts, appearance.ts). On a Mac
 *  they are JsgbDialogsMac.mm, JsgbClipboardMac.mm and JsgbSystemMac.mm; JsgbSystem.cpp has the other platforms. */

/** Shows a dialog and waits until the person answers, as a browser's alert, confirm and prompt do. Kind is "alert",
 *  "confirm" or "prompt"; DefaultText fills a prompt's field. True for OK, false for Cancel; OutText is what the person
 *  typed into a prompt. Call it on the page's JavaScript thread: the dialog itself runs on the main thread. */
bool JsgbRunDialog(const FString& Kind, const FString& Message, const FString& DefaultText, FString& OutText);

/** The web types on the clipboard now, as a JSON array: "text/plain", "text/html", "image/png" and "Files". */
FString JsgbClipboardTypes();
/** The clipboard's text of a web type ("text/plain" or "text/html"); empty when it has none. */
FString JsgbClipboardString(const FString& Type);
/** The clipboard's picture as PNG bytes (a picture in another format is converted); false when it holds none. */
bool JsgbClipboardPng(TArray<uint8>& OutPng);
/** Files copied in the Finder or Explorer, as the page reads them (FJsgbFiles::Describe); "[]" when there are none. */
FString JsgbClipboardFiles();
/** Replaces the clipboard's contents with text of each web type (text/plain, text/html) and an optional PNG picture,
 *  together as one item, as a browser writes a ClipboardItem. False when nothing could be written. */
bool JsgbClipboardWrite(const TMap<FString, FString>& Texts, const TArray<uint8>& Png);

/** "dark" or "light" from the system's appearance; empty when this platform can't tell. Any thread; cheap. */
FString JsgbColorScheme();
/** The system's time zone as an IANA name ("America/Los_Angeles"); empty when this platform can't tell. */
FString JsgbTimeZoneName();
