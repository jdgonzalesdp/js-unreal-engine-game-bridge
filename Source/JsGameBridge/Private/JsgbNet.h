#pragma once

#include "CoreMinimal.h"

/** Network requests and secure random bytes for the game's JavaScript, shared by the page (UJsgbBridge) and its
 *  worker threads (JsgbWorkers.cpp), which reach the same origins. Thread-safe. */
struct FJsgbNet
{
	/** The origins fetch() may reach ("https://api.example.com"), replacing the last list; drops unclaimed replies. */
	static void SetAllowed(const TArray<FString>& Origins);
	/** Starts a request: its id, or 0 when the URL's origin isn't allowed. */
	static int32 Start(const FString& Method, const FString& Url, const FString& HeadersJson, const uint8* Body, int32 BodyLength);
	/** The reply once it is in: [status int32 (0 for a network error), header JSON length int32, header JSON padded to
	 *  4 bytes, body], as Runtime/src/netFetch.ts reads it. False while the request is in flight. */
	static bool Take(int32 Id, TArray<uint8>& Out);
	/** Count bytes (1 to 65536) from OpenSSL's generator; false if it fails. */
	static bool RandomBytes(int32 Count, TArray<uint8>& Out);
	/** Streamed requests (JsgbNetStream.cpp, Runtime/src/fetchStream.ts): the status and headers as soon as they arrive,
	 *  then the body in pieces. StartStream returns an id, or 0 for a refused URL. ReadStream is false while nothing new
	 *  has come, then [flags int32 (1 head, 2 done, 4 failed), status int32, headers JSON length int32, headers JSON
	 *  padded to 4 bytes (with the head only), the body bytes since the last read]. CancelStream ends one request;
	 *  CancelStreams ends them all (a page that restarts). */
	static int32 StartStream(const FString& Method, const FString& Url, const FString& HeadersJson, const uint8* Body, int32 BodyLength);
	static bool ReadStream(int32 Id, TArray<uint8>& Out);
	static void CancelStream(int32 Id);
	static void CancelStreams();
	/** Whether the game may reach the URL's origin; a refusal is logged. */
	static bool IsAllowed(const FString& Method, const FString& Url);
	/** "scheme://host[:port]" in lower case, or empty for a URL without a scheme. */
	static FString OriginOf(const FString& Url);
};
