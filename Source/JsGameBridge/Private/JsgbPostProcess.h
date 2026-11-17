#pragma once

#include "CoreMinimal.h"

class UJsgbSceneMirror;
class FJsonObject;

/** The page's full-screen post-processing passes (an EffectComposer chain: exposure, white balance, tone curves,
 *  LUTs, grades) as Unreal post-process materials, in the browser's order, after the scene and before Unreal's
 *  tonemapper, which then only encodes for the display. Runtime/src/postPasses.ts sends three events through the
 *  mirror's event stream: "postShader" (a pass's translated HLSL, once), "postTexture" (a lookup texture's float
 *  pixels, when it changes) and "post" (the chain and its parameter values, when they change). */
namespace JsgbPostProcess
{
	void Apply(UJsgbSceneMirror* Mirror, const FString& Kind, const TSharedPtr<FJsonObject>& Event);
}
