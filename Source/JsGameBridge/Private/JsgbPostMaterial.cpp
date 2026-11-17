#include "JsgbPostMaterial.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionTextureObjectParameter.h"
#include "Materials/MaterialExpressionSceneTexture.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "MaterialDomain.h"
#include "MaterialShared.h"
#include "Engine/Texture.h"
#include "Dom/JsonObject.h"
#include "RHI.h"
#include "UObject/Package.h"

UMaterial* JsgbPostMaterial::Build(const FString& Key, const TSharedPtr<FJsonObject>& Shader, FString& Error)
{
#if WITH_EDITOR
	// Unset texture parameters read black (a pass's input the bridge can't follow adds nothing) or the engine's
	// default volume.
	static UTexture* Black = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineResources/Black.Black"));
	static UTexture* Volume = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineResources/DefaultVolumeTexture.DefaultVolumeTexture"));
	UMaterial* Mat = NewObject<UMaterial>(GetTransientPackage(), NAME_None, RF_Transient);
	Mat->MaterialDomain = MD_PostProcess;
	// After the scene's fog and background material (before depth of field) and before Unreal's tonemapper, which
	// the mirror keeps to plain display encoding while a composer draws the view (no tone curve, exposure 1).
	Mat->BlendableLocation = BL_SceneColorAfterDOF;
	Mat->SetShadingModel(MSM_Unlit);
	auto Add = [Mat](UMaterialExpression* E) { Mat->GetExpressionCollection().AddExpression(E); return E; };
	UMaterialExpressionCustom* Custom = NewObject<UMaterialExpressionCustom>(Mat);
	Custom->Code = Shader->GetStringField(TEXT("hlsl"));
	Custom->OutputType = CMOT_Float4;
	Custom->Description = Key;
	Custom->Inputs.Reset();
	const TArray<TSharedPtr<FJsonValue>>* Inputs = nullptr;
	Shader->TryGetArrayField(TEXT("inputs"), Inputs);
	for (const TSharedPtr<FJsonValue>& V : Inputs ? *Inputs : TArray<TSharedPtr<FJsonValue>>())
	{
		const TSharedPtr<FJsonObject> In = V->AsObject();
		if (!In) { continue; }
		const FString Source = In->GetStringField(TEXT("source"));
		FString Param; In->TryGetStringField(TEXT("param"), Param);
		UMaterialExpression* E = nullptr;
		int32 Output = 0;
		if (Source == TEXT("scalar")) { UMaterialExpressionScalarParameter* P = NewObject<UMaterialExpressionScalarParameter>(Mat); P->ParameterName = *Param; P->DefaultValue = 0.f; E = P; }
		// Output 5 of a vector parameter is RGBA: the Custom node takes a float4.
		else if (Source == TEXT("vector")) { UMaterialExpressionVectorParameter* P = NewObject<UMaterialExpressionVectorParameter>(Mat); P->ParameterName = *Param; P->DefaultValue = FLinearColor(0, 0, 0, 0); E = P; Output = 5; }
		else if (Source == TEXT("texture") || Source == TEXT("volume"))
		{
			UMaterialExpressionTextureObjectParameter* P = NewObject<UMaterialExpressionTextureObjectParameter>(Mat);
			P->ParameterName = *Param;
			P->Texture = Source == TEXT("volume") ? Volume : Black;
			// The sampler type only has to suit the default texture; the code samples whatever texture is set.
			P->AutoSetSampleType();
			E = P;
		}
		// The code looks the scene colour and depth up itself (SceneTextureLookup); these inputs only make Unreal bind
		// them. Unreal strips an input pin the code never reads and keeps the texture.
		else if (Source == TEXT("sceneColor") || Source == TEXT("sceneDepth"))
		{
			UMaterialExpressionSceneTexture* T = NewObject<UMaterialExpressionSceneTexture>(Mat);
			T->SceneTextureId = Source == TEXT("sceneColor") ? PPI_PostProcessInput0 : PPI_SceneDepth;
			E = T;
		}
		if (!E) { Error = FString::Printf(TEXT("input %s has a source the post material does not know (%s)"), *In->GetStringField(TEXT("name")), *Source); return nullptr; }
		Add(E);
		FCustomInput CI;
		CI.InputName = *In->GetStringField(TEXT("name"));
		CI.Input.Connect(Output, E);
		Custom->Inputs.Add(CI);
	}
	Add(Custom);
	UMaterialExpressionComponentMask* Rgb = NewObject<UMaterialExpressionComponentMask>(Mat);
	Rgb->R = Rgb->G = Rgb->B = true; Rgb->A = false;
	Rgb->Input.Connect(0, Custom);
	Add(Rgb);
	Mat->GetEditorOnlyData()->EmissiveColor.Connect(0, Rgb);
	Mat->PreEditChange(nullptr);
	Mat->PostEditChange();
	// Compiled now, so the first frame that shows the pass already has it; a failed compile is reported, never shown.
	FMaterialResource* Resource = Mat->GetMaterialResource(GMaxRHIShaderPlatform);
	if (!Resource) { Error = TEXT("Unreal made no material resource for this platform"); return nullptr; }
	Resource->FinishCompilation();
	const TArray<FString>& Errors = Resource->GetCompileErrors();
	if (Errors.Num()) { Error = FString::Printf(TEXT("its HLSL did not compile: %s"), *FString::Join(Errors, TEXT(" | "))); return nullptr; }
	return Mat;
#else
	Error = TEXT("post-process materials are compiled at runtime, which needs the editor build");
	return nullptr;
#endif
}
