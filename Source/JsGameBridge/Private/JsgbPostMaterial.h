#pragma once

#include "CoreMinimal.h"

class UMaterial;
class FJsonObject;

/** Builds one post-process material from a pass's translated shader (Runtime/src/postHlsl.ts): a Custom node with the
 *  HLSL, its parameters as material parameters, and the scene colour and depth it looks up, into emissive colour.
 *  Materials compile in the editor; a packaged game can't compile them, and Error says so. */
namespace JsgbPostMaterial
{
	UMaterial* Build(const FString& Key, const TSharedPtr<FJsonObject>& Shader, FString& Error);
}
