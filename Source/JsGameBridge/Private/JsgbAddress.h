#pragma once

#include "CoreMinimal.h"
#include "HttpResultCallback.h"

struct FHttpServerRequest;
class UJsgbBridge;

/** The page's address in a game that runs a web app, kept across restarts, and the system browser round trip a sign-in
 *  needs (RFC 8252, loopback redirect): the page opens the sign-in server in the system browser, and the browser comes
 *  back to one of the game's callback paths ("callbackPaths" in publication.json) on this host's own port, which the
 *  game's origin names ("origin": "http://localhost:5180"). Runtime/src/location.ts is the page's side. */
struct FJsgbAddress
{
	/** Remembers the path and query ("/auth/callback?code=1") the page starts at next time. Any thread. */
	static void Set(const FString& PathAndQuery);
	/** Opens an http or https URL in the system browser, and expects one return to a callback path within 15 minutes.
	 *  False for any other URL. Any thread. */
	static bool OpenExternal(const FString& Url);
	/** Answers a GET for one of the game's callback paths that this machine's browser sends to the game's own address,
	 *  then restarts the page there. False for any other request, which the caller handles. Game thread. */
	static bool HandleCallback(const FHttpServerRequest& Request, const FHttpResultCallback& Done, UJsgbBridge* Bridge);
};
