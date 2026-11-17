// Host services for the game's JavaScript that a browser has and Puerts' V8 doesn't: network requests for fetch()
// (Runtime/src/netFetch.ts), secure random bytes for crypto.getRandomValues, and the list of origins a game may reach.
//
// The host decides which origins a game may reach: the game's "netAllow" list (Games/<game>.json, carried in
// publication.json) and -JsgbNetAllow=<origin>,<origin>. With neither, every request is refused, so a game ported
// without one stays offline as before. The page and its worker threads share the list and the requests.
#include "JsgbNet.h"
#include "JsgbBridge.h"
#include "Async/Async.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/ScopeLock.h"
#include <atomic>
// OpenSSL's UI type clashes with Unreal's UI namespace; Unreal's own SSL code renames it the same way.
#define UI UI_ST
THIRD_PARTY_INCLUDES_START
#include <openssl/rand.h>
THIRD_PARTY_INCLUDES_END
#undef UI

DEFINE_LOG_CATEGORY_STATIC(LogJsgbNet, Log, All);

namespace
{
	FCriticalSection GLock;
	TArray<FString> GAllowed;
	TMap<int32, TArray<uint8>> GDone;
	std::atomic<int32> GNext{1};

	TArray<uint8> PackReply(int32 Status, const FString& HeadersJson, const TArray<uint8>& Body)
	{
		const FTCHARToUTF8 Utf8(*HeadersJson);
		const int32 Length = Utf8.Length(), Padded = (Length + 3) & ~3;
		TArray<uint8> Out;
		Out.SetNumZeroed(8 + Padded + Body.Num());
		FMemory::Memcpy(Out.GetData(), &Status, 4);
		FMemory::Memcpy(Out.GetData() + 4, &Length, 4);
		FMemory::Memcpy(Out.GetData() + 8, Utf8.Get(), Length);
		if (Body.Num() > 0) { FMemory::Memcpy(Out.GetData() + 8 + Padded, Body.GetData(), Body.Num()); }
		return Out;
	}

	FString ResponseHeadersJson(const FHttpResponsePtr& Response)
	{
		const TSharedRef<FJsonObject> Headers = MakeShared<FJsonObject>();
		for (const FString& Line : Response->GetAllHeaders())
		{
			FString Key, Value;
			if (Line.Split(TEXT(":"), &Key, &Value)) { Headers->SetStringField(Key.TrimStartAndEnd().ToLower(), Value.TrimStartAndEnd()); }
		}
		FString Json;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
		FJsonSerializer::Serialize(Headers, Writer);
		return Json;
	}
}

FString FJsgbNet::OriginOf(const FString& Url)
{
	const int32 SchemeEnd = Url.Find(TEXT("://"));
	if (SchemeEnd <= 0) { return FString(); }
	int32 End = Url.Len();
	for (const TCHAR* Stop : {TEXT("/"), TEXT("?"), TEXT("#")})
	{
		const int32 At = Url.Find(Stop, ESearchCase::CaseSensitive, ESearchDir::FromStart, SchemeEnd + 3);
		if (At != INDEX_NONE) { End = FMath::Min(End, At); }
	}
	return Url.Left(End).ToLower();
}

void FJsgbNet::SetAllowed(const TArray<FString>& Origins)
{
	// A page starting again: requests the last one left streaming (an event stream never ends) stop here.
	CancelStreams();
	FScopeLock Lock(&GLock);
	GAllowed.Reset();
	for (const FString& Origin : Origins)
	{
		const FString Clean = OriginOf(Origin.TrimStartAndEnd());
		if (!Clean.IsEmpty()) { GAllowed.AddUnique(Clean); }
	}
	GDone.Reset();
	UE_LOG(LogJsgbNet, Log, TEXT("network: %s"), GAllowed.Num() > 0 ? *FString::Join(GAllowed, TEXT(", ")) : TEXT("off (no netAllow)"));
}

int32 FJsgbNet::Start(const FString& Method, const FString& Url, const FString& HeadersJson, const uint8* Body, int32 BodyLength)
{
	const FString Origin = OriginOf(Url);
	{
		FScopeLock Lock(&GLock);
		if (Origin.IsEmpty() || !GAllowed.Contains(Origin))
		{
			UE_LOG(LogJsgbNet, Warning, TEXT("refused %s %s: %s is not in the game's netAllow list or -JsgbNetAllow"), *Method, *Url, *Origin);
			return 0;
		}
	}
	const int32 Id = GNext.fetch_add(1);
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(Method);
	TSharedPtr<FJsonObject> Headers;
	if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(HeadersJson), Headers) && Headers.IsValid())
	{
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Headers->Values) { Request->SetHeader(Pair.Key, Pair.Value->AsString()); }
	}
	if (Body && BodyLength > 0) { Request->SetContent(TArray<uint8>(Body, BodyLength)); }
	Request->OnProcessRequestComplete().BindLambda([Id](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		const bool bOk = bConnected && Response.IsValid();
		TArray<uint8> Reply = PackReply(bOk ? Response->GetResponseCode() : 0, bOk ? ResponseHeadersJson(Response) : TEXT("{}"), bOk ? Response->GetContent() : TArray<uint8>());
		FScopeLock Lock(&GLock);
		GDone.Add(Id, MoveTemp(Reply));
	});
	// The page's JavaScript thread and worker threads start requests on the game thread, where Unreal's HTTP manager
	// expects them.
	if (IsInGameThread()) { Request->ProcessRequest(); }
	else { AsyncTask(ENamedThreads::GameThread, [Request] { Request->ProcessRequest(); }); }
	return Id;
}

bool FJsgbNet::IsAllowed(const FString& Method, const FString& Url)
{
	const FString Origin = OriginOf(Url);
	FScopeLock Lock(&GLock);
	if (!Origin.IsEmpty() && GAllowed.Contains(Origin)) { return true; }
	UE_LOG(LogJsgbNet, Warning, TEXT("refused %s %s: %s is not in the game's netAllow list or -JsgbNetAllow"), *Method, *Url, *Origin);
	return false;
}

bool FJsgbNet::Take(int32 Id, TArray<uint8>& Out)
{
	FScopeLock Lock(&GLock);
	TArray<uint8>* Done = GDone.Find(Id);
	if (!Done) { return false; }
	Out = MoveTemp(*Done);
	GDone.Remove(Id);
	return true;
}

bool FJsgbNet::RandomBytes(int32 Count, TArray<uint8>& Out)
{
	if (Count <= 0 || Count > 65536) { return false; }
	Out.SetNumUninitialized(Count);
	// A failure is logged; the runtime then falls back to its own generator.
	if (RAND_bytes(Out.GetData(), Count) != 1) { UE_LOG(LogJsgbNet, Error, TEXT("RAND_bytes failed")); Out.Reset(); return false; }
	return true;
}

void UJsgbBridge::ConfigureNet()
{
	TArray<FString> Origins;
	// The game's own list, from the publication.json the build wrote beside the bundle.
	FString PublicationText;
	TSharedPtr<FJsonObject> Publication;
	const FString PublicationPath = FPaths::Combine(FPaths::GetPath(BundlePath), TEXT("publication.json"));
	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (FFileHelper::LoadFileToString(PublicationText, *PublicationPath) && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(PublicationText), Publication)
		&& Publication.IsValid() && Publication->TryGetArrayField(TEXT("netAllow"), List))
	{
		for (const TSharedPtr<FJsonValue>& Value : *List) { Origins.Add(Value->AsString()); }
	}
	// More from the command line: -JsgbNetAllow=https://a.example,https://b.example
	FString Extra;
	if (FParse::Value(FCommandLine::Get(), TEXT("JsgbNetAllow="), Extra, false))
	{
		TArray<FString> Parts;
		Extra.ParseIntoArray(Parts, TEXT(","), true);
		Origins.Append(Parts);
	}
	FJsgbNet::SetAllowed(Origins);
}

FArrayBufferValue UJsgbBridge::RandomBytes(int32 Count)
{
	FArrayBufferValue Out;
	FJsgbNet::RandomBytes(Count, Out.Data);
	return Out;
}

int32 UJsgbBridge::HttpStart(const FString& Method, const FString& Url, const FString& HeadersJson, FArrayBuffer Body)
{
	return FJsgbNet::Start(Method, Url, HeadersJson, static_cast<const uint8*>(Body.Data), static_cast<int32>(Body.Data ? Body.Length : 0));
}

FArrayBufferValue UJsgbBridge::HttpTake(int32 Id)
{
	FArrayBufferValue Out;
	FJsgbNet::Take(Id, Out.Data);
	return Out;
}
