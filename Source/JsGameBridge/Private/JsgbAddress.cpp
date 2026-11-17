// The page's address and the system browser round trip of a sign-in (JsgbAddress.h). The page's side is
// Runtime/src/location.ts: pushState and replaceState report the address (SetAddress), so every restart comes back to
// it; another origin's http(s) URL opens in the system browser (OpenExternal); and a callback the browser brings back
// restarts the page at the callback address, where the game's sign-in library finishes the sign-in.
//
// Who may bring a callback: only this machine (a loopback peer), only to the game's own address (the Host header names
// the origin's host, which the overlay's requests to 127.0.0.1 and a rebinding attacker's name don't), only as a page
// load (Sec-Fetch-Mode navigate when the browser sends it), and only once after the page opened an external URL, within
// 15 minutes. Anything else gets no restart.
#include "JsgbAddress.h"
#include "JsgbBridge.h"
#include "JsgbNet.h"
#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HttpServerRequest.h"
#include "HttpServerResponse.h"
#include "IPAddress.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/SWindow.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbAddress, Log, All);

namespace
{
	constexpr double AddressReturnWindowSeconds = 15 * 60;

	FCriticalSection GAddressLock;
	/** The path and query the page starts at next; empty until the page reports one. Lives as long as the process. */
	FString GNextAddress;
	/** Until when (FPlatformTime::Seconds) a return from the system browser is expected; 0 when none is. */
	double GAddressReturnUntil = 0;
	/** The origin's "host[:port]", the game's callback paths and its name, from ConfigureAddress. */
	FString GAddressHost, GAddressTitle, GAddressOrigin;
	TArray<FString> GAddressCallbackPaths;
	/** The one return the page is waiting for: its path, and the sign-in's state (none for a sign-out's return). */
	FString GExpectedPath, GExpectedState;
	bool GExpectNoQuery = false;

	bool IsLoopbackPeer(const TSharedPtr<FInternetAddr>& Peer)
	{
		if (!Peer.IsValid()) { return false; }
		const TArray<uint8> Ip = Peer->GetRawIp();
		if (Ip.Num() == 4) { return Ip[0] == 127; }
		if (Ip.Num() != 16) { return false; }
		for (int32 I = 0; I < 10; ++I) { if (Ip[I] != 0) { return false; } }
		// ::ffff:127.x.x.x (IPv4 through an IPv6 socket) or ::1.
		if (Ip[10] == 0xff && Ip[11] == 0xff) { return Ip[12] == 127; }
		return Ip[10] == 0 && Ip[11] == 0 && Ip[12] == 0 && Ip[13] == 0 && Ip[14] == 0 && Ip[15] == 1;
	}

	FString RequestHeader(const FHttpServerRequest& Request, const TCHAR* Name)
	{
		const TArray<FString>* Values = Request.Headers.Find(Name);
		return Values && Values->Num() > 0 ? (*Values)[0].TrimStartAndEnd() : FString();
	}

	/** A small page for the system browser's tab, in the game's own words. */
	TUniquePtr<FHttpServerResponse> CallbackPage(const FString& Title, const FString& Headline, const FString& Line)
	{
		const FString Html = FString::Printf(TEXT("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
			"<title>%s</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;"
			"font:16px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:Canvas;color:CanvasText}"
			"main{max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>"
			"<body><main><h1>%s</h1><p>%s</p></main></body></html>"),
			*FGenericPlatformHttp::HtmlEncode(Title), *FGenericPlatformHttp::HtmlEncode(Headline), *FGenericPlatformHttp::HtmlEncode(Line));
		TUniquePtr<FHttpServerResponse> Response = FHttpServerResponse::Create(Html, TEXT("text/html; charset=utf-8"));
		TArray<FString> NoStore = {TEXT("no-store")}, NoReferrer = {TEXT("no-referrer")};
		Response->Headers.Add(TEXT("cache-control"), MoveTemp(NoStore));
		// The callback's query carries a one-time code: keep it out of any Referer header the tab might send.
		Response->Headers.Add(TEXT("referrer-policy"), MoveTemp(NoReferrer));
		return Response;
	}

	void BringGameWindowToFrontForCallback()
	{
#if PLATFORM_MAC
		FPlatformApplicationMisc::ActivateApplication();
#endif
		if (GEngine && GEngine->GameViewport)
		{
			if (const TSharedPtr<SWindow> Window = GEngine->GameViewport->GetWindow()) { Window->BringToFront(true); }
		}
	}
}

void FJsgbAddress::Set(const FString& PathAndQuery)
{
	FString Address = PathAndQuery.Left(8192);
	int32 Hash = INDEX_NONE;
	if (Address.FindChar(TEXT('#'), Hash)) { Address.LeftInline(Hash); }
	if (!Address.StartsWith(TEXT("/")) || Address.StartsWith(TEXT("//"))) { return; }
	FScopeLock Lock(&GAddressLock);
	GNextAddress = Address;
}

bool FJsgbAddress::OpenExternal(const FString& Url)
{
	const bool bWeb = Url.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase) || Url.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase);
	bool bPlain = Url.Len() <= 16384;
	for (const TCHAR C : Url) { if (C <= 32 || C == 127) { bPlain = false; break; } }
	if (!bWeb || !bPlain) { UE_LOG(LogJsgbAddress, Warning, TEXT("Not opened in the system browser (only http and https URLs are): %s"), *Url.Left(200)); return false; }
	// A return is expected only when the opened URL names this page's origin as where to come back: a sign-in's
	// redirect_uri, bound to its state, or a sign-out's returnTo. Help links, downloads and payments expect nothing,
	// so a later visit to the origin in the browser can't restart the page.
	const TOptional<FString> Redirect = FGenericPlatformHttp::GetUrlParameter(Url, TEXT("redirect_uri"));
	TOptional<FString> Back = Redirect;
	if (!Back.IsSet()) { Back = FGenericPlatformHttp::GetUrlParameter(Url, TEXT("returnTo")); }
	if (!Back.IsSet()) { Back = FGenericPlatformHttp::GetUrlParameter(Url, TEXT("post_logout_redirect_uri")); }
	{
		FScopeLock Lock(&GAddressLock);
		const FString Target = Back.IsSet() ? Back.GetValue() : FString();
		FString ReturnPath = Target.IsEmpty() ? FString() : FGenericPlatformHttp::GetUrlPath(Target);
		if (ReturnPath.Len() > 1) { ReturnPath.RemoveFromEnd(TEXT("/")); }
		if (!Target.IsEmpty() && FJsgbNet::OriginOf(Target) == GAddressOrigin && GAddressCallbackPaths.Contains(ReturnPath))
		{
			GAddressReturnUntil = FPlatformTime::Seconds() + AddressReturnWindowSeconds;
			GExpectedPath = ReturnPath;
			GExpectedState = Redirect.IsSet() ? FGenericPlatformHttp::GetUrlParameter(Url, TEXT("state")).Get(FString()) : FString();
			GExpectNoQuery = !Redirect.IsSet();
		}
	}
	// The engine's LaunchURL logs the whole URL anyway; this line says where the browser goes.
	FString Where = Url;
	int32 Query = INDEX_NONE;
	if (Where.FindChar(TEXT('?'), Query)) { Where.LeftInline(Query); }
	UE_LOG(LogJsgbAddress, Display, TEXT("Opening in the system browser: %s"), *Where);
	auto Launch = [Url]
	{
		FString Error;
		FPlatformProcess::LaunchURL(*Url, nullptr, &Error);
		if (!Error.IsEmpty()) { UE_LOG(LogJsgbAddress, Warning, TEXT("The system browser did not open: %s"), *Error); }
	};
	if (IsInGameThread()) { Launch(); }
	else { AsyncTask(ENamedThreads::GameThread, MoveTemp(Launch)); }
	return true;
}

bool FJsgbAddress::HandleCallback(const FHttpServerRequest& Request, const FHttpResultCallback& Done, UJsgbBridge* Bridge)
{
	if (!Bridge || Request.Verb != EHttpServerRequestVerbs::VERB_GET) { return false; }
	const FString Route = Request.FullPath.GetPath();
	FString Host, Title, ExpectedPath, ExpectedState;
	double ReturnUntil = 0;
	bool bNoQuery = false;
	{
		FScopeLock Lock(&GAddressLock);
		if (Route.StartsWith(TEXT("/bridge/")) || !GAddressCallbackPaths.Contains(Route)) { return false; }
		Host = GAddressHost; Title = GAddressTitle; ReturnUntil = GAddressReturnUntil;
		ExpectedPath = GExpectedPath; ExpectedState = GExpectedState; bNoQuery = GExpectNoQuery;
	}
	if (!RequestHeader(Request, TEXT("host")).Equals(Host, ESearchCase::IgnoreCase)) { return false; }
	// Only a top-level navigation in the browser: not a fetch, an image or a frame on some other site.
	const FString Mode = RequestHeader(Request, TEXT("sec-fetch-mode")), Dest = RequestHeader(Request, TEXT("sec-fetch-dest"));
	if (!IsLoopbackPeer(Request.PeerAddress) || (!Mode.IsEmpty() && Mode != TEXT("navigate")) || (!Dest.IsEmpty() && Dest != TEXT("document")))
	{
		Done(FHttpServerResponse::Error(EHttpServerResponseCodes::Forbidden));
		return true;
	}
	const FString Back = TEXT("You can close this tab and go back to Unreal.");
	// The return must be the one the page opened: the same path, and the sign-in's own state (a sign-out comes back
	// with no query). Anything else leaves the page alone and keeps waiting.
	const FString* State = Request.QueryParams.Find(TEXT("state"));
	const bool bExpected = Route == ExpectedPath && (bNoQuery ? Request.QueryParams.Num() == 0 : (!ExpectedState.IsEmpty() && State && *State == ExpectedState));
	if (FPlatformTime::Seconds() > ReturnUntil || !bExpected)
	{
		Done(CallbackPage(Title, FString::Printf(TEXT("%s is running in Unreal."), *Title), TEXT("There is nothing to finish here. You can close this tab.")));
		return true;
	}
	{
		FScopeLock Lock(&GAddressLock);
		GAddressReturnUntil = 0;
		GExpectedPath.Reset(); GExpectedState.Reset();
	}
	// Unreal's server decoded each query parameter; the page gets them encoded again.
	FString Address = Route;
	for (const TPair<FString, FString>& Param : Request.QueryParams)
	{
		Address += (Address.Contains(TEXT("?")) ? TEXT("&") : TEXT("?")) + FGenericPlatformHttp::UrlEncode(Param.Key) + TEXT("=") + FGenericPlatformHttp::UrlEncode(Param.Value);
	}
	const bool bFailed = Request.QueryParams.Contains(TEXT("error"));
	const bool bSignedIn = !bFailed && Request.QueryParams.Contains(TEXT("code"));
	const bool bSignedOut = !bFailed && !bSignedIn && Route == TEXT("/") && Request.QueryParams.Num() == 0;
	Done(bFailed ? CallbackPage(Title, FString::Printf(TEXT("%s could not finish signing in."), *Title), TEXT("Go back to Unreal to see why, then close this tab."))
		: bSignedIn ? CallbackPage(Title, FString::Printf(TEXT("Finishing sign-in to %s."), *Title), Back)
		: bSignedOut ? CallbackPage(Title, FString::Printf(TEXT("Signed out of %s."), *Title), Back)
		: CallbackPage(Title, FString::Printf(TEXT("Back to %s."), *Title), Back));
	UE_LOG(LogJsgbAddress, Display, TEXT("The system browser came back to %s; restarting the page there"), *Route);
	// The address is set here too, so the restart lands there even if the page cannot answer. A page already there (a
	// sign-out restarted at its returnTo when it opened the browser) is left as it is.
	FString Current;
	{ FScopeLock Lock(&GAddressLock); Current = GNextAddress; }
	Set(Address);
	if (Current != Address)
	{
		Bridge->RunOnJs([Bridge, Address]
		{
			// The page saves its storage, then asks for the restart (Runtime/src/location.ts navigateTo).
			if (Bridge->OnNavigate.IsBound()) { Bridge->OnNavigate.Execute(Address); }
			else { Bridge->RequestReload(); }
		});
	}
	BringGameWindowToFrontForCallback();
	return true;
}

void UJsgbBridge::SetAddress(const FString& PathAndQuery) { FJsgbAddress::Set(PathAndQuery); }

bool UJsgbBridge::OpenExternal(const FString& Url) { return FJsgbAddress::OpenExternal(Url); }

void UJsgbBridge::ConfigureAddress()
{
	FString Text, Configured, Title;
	TSharedPtr<FJsonObject> Publication;
	TArray<FString> CallbackPaths;
	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (FFileHelper::LoadFileToString(Text, *FPaths::Combine(FPaths::GetPath(BundlePath), TEXT("publication.json")))
		&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Publication) && Publication.IsValid())
	{
		Publication->TryGetStringField(TEXT("origin"), Configured);
		if (!Publication->TryGetStringField(TEXT("gameTitle"), Title)) { Publication->TryGetStringField(TEXT("title"), Title); }
		if (Publication->TryGetArrayField(TEXT("callbackPaths"), List)) { for (const TSharedPtr<FJsonValue>& Value : *List) { CallbackPaths.Add(Value->AsString()); } }
	}
	// -JsgbOrigin=http://localhost:5180 overrides the game's origin.
	FParse::Value(FCommandLine::Get(), TEXT("JsgbOrigin="), Configured);
	Origin = FJsgbNet::OriginOf(Configured.TrimStartAndEnd());
	if (!Origin.StartsWith(TEXT("http://")) && !Origin.StartsWith(TEXT("https://"))) { Origin = TEXT("http://localhost"); }
	// A browser leaves the scheme's own port out of the address and the Host header.
	Origin.RemoveFromEnd(Origin.StartsWith(TEXT("https://")) ? TEXT(":443") : TEXT(":80"));
	const FString HostPart = Origin.Mid(Origin.Find(TEXT("://")) + 3);
	FString Start;
	{
		FScopeLock Lock(&GAddressLock);
		GAddressHost = HostPart;
		GAddressOrigin = Origin;
		GAddressTitle = Title.IsEmpty() ? FString(TEXT("The game")) : Title;
		GAddressCallbackPaths = CallbackPaths;
		Start = GNextAddress;
	}
	// The first start: -JsgbPath= (default "/") and the search the host was given (-JsgbSearch= or the game's own).
	if (Start.IsEmpty())
	{
		FString StartPath = TEXT("/");
		FParse::Value(FCommandLine::Get(), TEXT("JsgbPath="), StartPath);
		Start = (StartPath.StartsWith(TEXT("/")) ? StartPath : TEXT("/") + StartPath) + Search;
	}
	FString Query;
	if (Start.Split(TEXT("?"), &PagePath, &Query)) { Search = TEXT("?") + Query; }
	else { PagePath = Start; Search.Reset(); }
	if (CallbackPaths.Num() > 0)
	{
		int32 HostPort = 5292;
		FParse::Value(FCommandLine::Get(), TEXT("JsgbPort="), HostPort);
		const int32 Colon = HostPart.Find(TEXT(":"), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
		const int32 OriginPort = Colon != INDEX_NONE ? FCString::Atoi(*HostPart.Mid(Colon + 1)) : Origin.StartsWith(TEXT("https")) ? 443 : 80;
		if (OriginPort != HostPort)
		{
			UE_LOG(LogJsgbAddress, Warning, TEXT("Sign-in returns go to %s, but this host listens on port %d: start Unreal with -JsgbPort=%d"), *Origin, HostPort, OriginPort);
		}
	}
	UE_LOG(LogJsgbAddress, Log, TEXT("Page address %s%s%s"), *Origin, *PagePath, Search.IsEmpty() ? TEXT("") : TEXT(" (with a query)"));
}
