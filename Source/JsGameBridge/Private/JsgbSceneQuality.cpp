// window.jsgb.setSceneQuality (Runtime/src/sceneQuality.ts): the shared scene's quality tier and
// resolved sun/sky, normalized by the runtime before it arrives. Stage 1 keeps the request intact
// and observable; Unreal's native lighting stages translate it, never replace the shared save.
#include "JsgbBridge.h"
#include "Dom/JsonObject.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

void UJsgbBridge::SetSceneQuality(const FString& Json)
{
	const FString Next = Json.TrimStartAndEnd();
	if (!Next.IsEmpty())
	{
		if (Next.Len() > 8192) { return; }
		TSharedPtr<FJsonObject> Parsed;
		if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Next), Parsed) || !Parsed) { return; }
	}
	{
		FScopeLock Lock(&SceneQualityLock);
		if (SceneQualityJson == Next) { return; }
		SceneQualityJson = Next;
	}
	Log(TEXT("log"), Next.IsEmpty() ? TEXT("scene quality: the page dropped its request")
		: TEXT("scene quality: ") + Next.Left(512));
}

FString UJsgbBridge::GetSceneQuality()
{
	FScopeLock Lock(&SceneQualityLock);
	return SceneQualityJson;
}
