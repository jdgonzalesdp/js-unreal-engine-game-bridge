// The materials Unreal draws a page's render target passes with (JsgbPassRunner.h, Runtime/src/passHlsl.ts).
#include "JsgbPassRunner.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionTextureObjectParameter.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionOneMinus.h"
#include "MaterialDomain.h"
#include "MaterialShared.h"
#include "Engine/Texture.h"
#include "Dom/JsonObject.h"
#include "RHI.h"
#include "UObject/Package.h"

namespace
{
	struct FInput { FString Name, Source, Param; };

	UMaterial* Make(const FString& Key, const FString& Code, const TArray<FInput>& Inputs, FString& Error)
	{
#if WITH_EDITOR
		// An unset texture parameter reads black; the runner binds every texture a pass reads.
		static UTexture* Black = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineResources/Black.Black"));
		static UTexture* Volume = LoadObject<UTexture>(nullptr, TEXT("/Engine/EngineResources/DefaultVolumeTexture.DefaultVolumeTexture"));
		UMaterial* Mat = NewObject<UMaterial>(GetTransientPackage(), NAME_None, RF_Transient);
		Mat->MaterialDomain = MD_Surface;
		// Premultiplied blending: colour = emissive + target x (1 - opacity), alpha = target alpha x (1 - opacity). Over a
		// target cleared to (0, 0, 0, 1) that is the pass's colour, and its alpha when opacity is one minus that alpha.
		Mat->BlendMode = BLEND_AlphaComposite;
		Mat->SetShadingModel(MSM_Unlit);
		Mat->TwoSided = true;
		Mat->bDisableDepthTest = true;
		// A pass computes data as much as colour: negative values, and values beyond half float precision.
		Mat->bAllowNegativeEmissiveColor = true;
		Mat->FloatPrecisionMode = MFPM_Full;
		Mat->bUseTranslucencyVertexFog = false;
		auto Add = [Mat](UMaterialExpression* E) { Mat->GetExpressionCollection().AddExpression(E); return E; };
		UMaterialExpressionCustom* Custom = NewObject<UMaterialExpressionCustom>(Mat);
		Custom->Code = Code;
		Custom->OutputType = CMOT_Float4;
		Custom->Description = Key;
		Custom->Inputs.Reset();
		for (const FInput& In : Inputs)
		{
			UMaterialExpression* E = nullptr;
			if (In.Source == TEXT("scalar")) { UMaterialExpressionScalarParameter* P = NewObject<UMaterialExpressionScalarParameter>(Mat); P->ParameterName = *In.Param; P->DefaultValue = 0.f; E = P; }
			else if (In.Source == TEXT("vector")) { UMaterialExpressionVectorParameter* P = NewObject<UMaterialExpressionVectorParameter>(Mat); P->ParameterName = *In.Param; P->DefaultValue = FLinearColor(0, 0, 0, 0); E = P; }
			else if (In.Source == TEXT("texture") || In.Source == TEXT("volume"))
			{
				UMaterialExpressionTextureObjectParameter* P = NewObject<UMaterialExpressionTextureObjectParameter>(Mat);
				P->ParameterName = *In.Param;
				P->Texture = In.Source == TEXT("volume") ? Volume : Black;
				P->AutoSetSampleType();
				E = P;
			}
			// The pixel's place in the target, 0 to 1 from the first row in memory: WebGL's uv for a pass target.
			else if (In.Source == TEXT("uv")) { UMaterialExpressionTextureCoordinate* T = NewObject<UMaterialExpressionTextureCoordinate>(Mat); T->CoordinateIndex = 0; E = T; }
			if (!E) { Error = FString::Printf(TEXT("input %s has a source a pass material does not know (%s)"), *In.Name, *In.Source); return nullptr; }
			Add(E);
			FCustomInput CI;
			CI.InputName = *In.Name;
			// Output 5 of a vector parameter is RGBA: the Custom node takes a float4.
			CI.Input.Connect(In.Source == TEXT("vector") ? 5 : 0, E);
			Custom->Inputs.Add(CI);
		}
		Add(Custom);
		UMaterialExpressionComponentMask* Rgb = NewObject<UMaterialExpressionComponentMask>(Mat);
		Rgb->R = Rgb->G = Rgb->B = true; Rgb->A = false;
		Rgb->Input.Connect(0, Custom);
		Add(Rgb);
		UMaterialExpressionComponentMask* Alpha = NewObject<UMaterialExpressionComponentMask>(Mat);
		Alpha->R = Alpha->G = Alpha->B = false; Alpha->A = true;
		Alpha->Input.Connect(0, Custom);
		Add(Alpha);
		UMaterialExpressionOneMinus* Opacity = NewObject<UMaterialExpressionOneMinus>(Mat);
		Opacity->Input.Connect(0, Alpha);
		Add(Opacity);
		Mat->GetEditorOnlyData()->EmissiveColor.Connect(0, Rgb);
		Mat->GetEditorOnlyData()->Opacity.Connect(0, Opacity);
		Mat->PreEditChange(nullptr);
		Mat->PostEditChange();
		// Compiled now: a material still compiling would draw Unreal's default material into the target instead.
		FMaterialResource* Resource = Mat->GetMaterialResource(GMaxRHIShaderPlatform);
		if (!Resource) { Error = TEXT("Unreal made no material resource for this platform"); return nullptr; }
		Resource->FinishCompilation();
		const TArray<FString>& Errors = Resource->GetCompileErrors();
		if (Errors.Num()) { Error = FString::Printf(TEXT("its HLSL did not compile: %s"), *FString::Join(Errors, TEXT(" | "))); return nullptr; }
		return Mat;
#else
		Error = TEXT("pass materials are compiled at runtime, which needs the editor build");
		return nullptr;
#endif
	}
}

UMaterial* JsgbPassRunner::BuildMaterial(const FString& Key, const TSharedPtr<FJsonObject>& Shader, FString& Error)
{
	TArray<FInput> Inputs;
	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (Shader->TryGetArrayField(TEXT("inputs"), List))
	{
		for (const TSharedPtr<FJsonValue>& V : *List)
		{
			const TSharedPtr<FJsonObject> In = V->AsObject();
			if (!In) { continue; }
			FInput I;
			I.Name = In->GetStringField(TEXT("name"));
			I.Source = In->GetStringField(TEXT("source"));
			In->TryGetStringField(TEXT("param"), I.Param);
			Inputs.Add(I);
		}
	}
	return Make(Key, Shader->GetStringField(TEXT("hlsl")), Inputs, Error);
}

UMaterial* JsgbPassRunner::CopyMaterial(FString& Error)
{
	// The capture holds the picture's top row first; WebGL's first row is its bottom.
	return Make(TEXT("jsgb_pass_copy"), TEXT("return float4(Src.SampleLevel(SrcSampler, float2(Uv.x, 1.0 - Uv.y), 0).rgb, 1.0);"),
		{{TEXT("Src"), TEXT("texture"), TEXT("Src")}, {TEXT("Uv"), TEXT("uv"), FString()}}, Error);
}

UMaterial* JsgbPassRunner::CheckMaterial(FString& Error)
{
	return Make(TEXT("jsgb_pass_check"), TEXT("return float4(0.25, -0.5, 2.0, 0.75);"), {}, Error);
}
