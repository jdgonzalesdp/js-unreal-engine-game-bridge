// Streamed network requests for the page's fetch() (Runtime/src/fetchStream.ts). A browser resolves fetch() once the
// status and headers are in and hands the body over piece by piece as it arrives. The whole-reply requests in
// JsgbNet.cpp answer only when a request ends, so a server-sent event stream (which never ends) delivered nothing and
// a streamed reply arrived all at once. Here the status and headers are kept as soon as they come, each piece of the
// body as it comes, and the page reads whatever is new each time it asks. The page can cancel a request
// (AbortController, or a cancelled body), and a page that restarts cancels every request the last one left open.
// Requests reach only the origins the game may (FJsgbNet::IsAllowed), as whole-reply ones do.
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
#include "Misc/ScopeLock.h"
#include <atomic>

namespace
{
	using FRequestRef = TSharedPtr<IHttpRequest, ESPMode::ThreadSafe>;

	/** One streamed request: what has arrived and the page has not read yet. */
	struct FStreamed
	{
		FRequestRef Request;
		int32 Status = 0;
		TMap<FString, FString> Headers;
		TArray<uint8> Body;
		bool bHead = false;     // the status and headers are complete
		bool bHeadRead = false; // the page has read them
		bool bDone = false;
		bool bFailed = false;
	};

	FCriticalSection GStreamLock;
	TMap<int32, FStreamed> GStreams;
	std::atomic<int32> GNextStream{1};

	void AddHeader(FStreamed& S, const FString& Name, const FString& Value)
	{
		const FString Key = Name.TrimStartAndEnd().ToLower();
		if (Key.IsEmpty()) { return; }
		if (FString* Old = S.Headers.Find(Key)) { *Old += TEXT(", ") + Value.TrimStartAndEnd(); }
		else { S.Headers.Add(Key, Value.TrimStartAndEnd()); }
	}

	void TakeHeaders(FStreamed& S, const FHttpResponsePtr& Response)
	{
		S.Headers.Reset();
		for (const FString& Line : Response->GetAllHeaders())
		{
			FString Name, Value;
			if (Line.Split(TEXT(":"), &Name, &Value)) { AddHeader(S, Name, Value); }
		}
	}

	FString HeadersJson(const TMap<FString, FString>& Headers)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		for (const TPair<FString, FString>& Pair : Headers) { Object->SetStringField(Pair.Key, Pair.Value); }
		FString Json;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
		FJsonSerializer::Serialize(Object, Writer);
		return Json;
	}

	/** Unreal's HTTP manager expects requests driven from the game thread. */
	void OnGameThread(const FRequestRef& Request, bool bCancel)
	{
		if (!Request.IsValid()) { return; }
		auto Run = [Request, bCancel] { if (bCancel) { Request->CancelRequest(); } else { Request->ProcessRequest(); } };
		if (IsInGameThread()) { Run(); } else { AsyncTask(ENamedThreads::GameThread, MoveTemp(Run)); }
	}
}

int32 FJsgbNet::StartStream(const FString& Method, const FString& Url, const FString& HeadersJsonText, const uint8* Body, int32 BodyLength)
{
	if (!IsAllowed(Method, Url)) { return 0; }
	const int32 Id = GNextStream.fetch_add(1);
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(Method);
	TSharedPtr<FJsonObject> Headers;
	if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(HeadersJsonText), Headers) && Headers.IsValid())
	{
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Headers->Values) { Request->SetHeader(Pair.Key, Pair.Value->AsString()); }
	}
	if (Body && BodyLength > 0) { Request->SetContent(TArray<uint8>(Body, BodyLength)); }
	// Every callback runs on the HTTP thread in the order things arrive, and touches only this request's entry.
	Request->SetDelegateThreadPolicy(EHttpRequestDelegateThreadPolicy::CompleteOnHttpThread);
	Request->OnStatusCodeReceived().BindLambda([Id](FHttpRequestPtr, int32 Code)
	{
		FScopeLock Lock(&GStreamLock);
		if (FStreamed* S = GStreams.Find(Id)) { S->Status = Code; }
	});
	Request->OnHeaderReceived().BindLambda([Id](FHttpRequestPtr Req, const FString& Name, const FString& Value)
	{
		FScopeLock Lock(&GStreamLock);
		FStreamed* S = GStreams.Find(Id);
		if (!S || S->bHead) { return; }
#if PLATFORM_APPLE
		// Apple's HTTP layer has every header by the first of these calls (it reports them one after another from the
		// response it already holds), so the head is complete now, before any of the body: take them all at once.
		const FHttpResponsePtr Response = Req.IsValid() ? Req->GetResponse() : nullptr;
		if (Response.IsValid() && S->Status > 0) { TakeHeaders(*S, Response); S->bHead = true; return; }
#endif
		// Elsewhere headers arrive one line at a time; the head is complete with the first body bytes or the end.
		AddHeader(*S, Name, Value);
	});
	Request->SetResponseBodyReceiveStreamDelegateV2(FHttpRequestStreamDelegateV2::CreateLambda([Id](void* Ptr, int64& Length)
	{
		FScopeLock Lock(&GStreamLock);
		FStreamed* S = GStreams.Find(Id);
		// A request the page cancelled: a length of 0 tells the HTTP module to stop receiving.
		if (!S) { Length = 0; return; }
		if (Length > 0) { S->Body.Append(static_cast<const uint8*>(Ptr), static_cast<int32>(Length)); }
		S->bHead = true;
	}));
	Request->OnProcessRequestComplete().BindLambda([Id](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		FScopeLock Lock(&GStreamLock);
		FStreamed* S = GStreams.Find(Id);
		if (!S) { return; }
		S->bFailed = !bConnected || !Response.IsValid();
		if (!S->bFailed)
		{
			if (S->Status <= 0) { S->Status = Response->GetResponseCode(); }
			if (!S->bHeadRead && S->Headers.Num() == 0) { TakeHeaders(*S, Response); }
		}
		S->bHead = true;
		S->bDone = true;
		S->Request.Reset();
	});
	{
		FScopeLock Lock(&GStreamLock);
		GStreams.Add(Id).Request = Request;
	}
	OnGameThread(Request, false);
	return Id;
}

bool FJsgbNet::ReadStream(int32 Id, TArray<uint8>& Out)
{
	FScopeLock Lock(&GStreamLock);
	FStreamed* S = GStreams.Find(Id);
	if (!S || (!S->bHead && !S->bDone)) { return false; }
	const bool bSendHead = !S->bHeadRead;
	if (!bSendHead && S->Body.Num() == 0 && !S->bDone) { return false; }
	const FTCHARToUTF8 Utf8(bSendHead ? *HeadersJson(S->Headers) : TEXT(""));
	const int32 Length = Utf8.Length(), Padded = (Length + 3) & ~3;
	const int32 Flags = (bSendHead ? 1 : 0) | (S->bDone ? 2 : 0) | (S->bFailed ? 4 : 0);
	Out.SetNumZeroed(12 + Padded + S->Body.Num());
	FMemory::Memcpy(Out.GetData(), &Flags, 4);
	FMemory::Memcpy(Out.GetData() + 4, &S->Status, 4);
	FMemory::Memcpy(Out.GetData() + 8, &Length, 4);
	if (Length > 0) { FMemory::Memcpy(Out.GetData() + 12, Utf8.Get(), Length); }
	if (S->Body.Num() > 0) { FMemory::Memcpy(Out.GetData() + 12 + Padded, S->Body.GetData(), S->Body.Num()); }
	S->bHeadRead = true;
	S->Body.Reset();
	if (S->bDone) { GStreams.Remove(Id); }
	return true;
}

void FJsgbNet::CancelStream(int32 Id)
{
	FRequestRef Request;
	{
		FScopeLock Lock(&GStreamLock);
		if (FStreamed* S = GStreams.Find(Id)) { Request = S->Request; GStreams.Remove(Id); }
	}
	OnGameThread(Request, true);
}

void FJsgbNet::CancelStreams()
{
	TArray<FRequestRef> Requests;
	{
		FScopeLock Lock(&GStreamLock);
		for (const TPair<int32, FStreamed>& Pair : GStreams) { if (Pair.Value.Request.IsValid()) { Requests.Add(Pair.Value.Request); } }
		GStreams.Reset();
	}
	for (const FRequestRef& Request : Requests) { OnGameThread(Request, true); }
}

int32 UJsgbBridge::HttpStream(const FString& Method, const FString& Url, const FString& HeadersJson, FArrayBuffer Body)
{
	return FJsgbNet::StartStream(Method, Url, HeadersJson, static_cast<const uint8*>(Body.Data), static_cast<int32>(Body.Data ? Body.Length : 0));
}

FArrayBufferValue UJsgbBridge::HttpRead(int32 Id)
{
	FArrayBufferValue Out;
	FJsgbNet::ReadStream(Id, Out.Data);
	return Out;
}

void UJsgbBridge::HttpCancel(int32 Id)
{
	FJsgbNet::CancelStream(Id);
}
