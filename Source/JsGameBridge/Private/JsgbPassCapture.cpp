// The scene a page's render target passes start from (JsgbPassRunner.h): the frame the mirror just applied, drawn from
// its camera as three draws a scene into a render target. three applies exposure and tone mapping only on the way to
// the screen, so this picture is linear light at exposure 1, with the scene's background and fog (the mirror's scene
// post material) and none of the view's other post-processing. JsgbCapture.cpp places its camera the same way.
#include "JsgbPassRunner.h"
#include "JsgbSceneMirror.h"
#include "Camera/CameraComponent.h"
#include "Components/PrimitiveComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/IConsoleManager.h"
#include "Materials/MaterialInstance.h"
#include "ShaderCompiler.h"

namespace
{
	constexpr float Cm = 100.f;
	TWeakObjectPtr<USceneCaptureComponent2D> PassCapture;

	/** Temporal anti-aliasing (TAA, TSR) needs a few frames of history after a camera cut; other methods need one. */
	int32 Passes()
	{
		const IConsoleVariable* Aa = IConsoleManager::Get().FindConsoleVariable(TEXT("r.AntiAliasingMethod"));
		const int32 Method = Aa ? Aa->GetInt() : 0;
		return Method == 2 || Method == 4 ? 6 : 1;
	}

	/** The mirror's background and fog material (M_JsgbScenePost): part of the scene three draws. */
	bool IsScenePost(const UObject* O)
	{
		const UMaterialInterface* M = Cast<UMaterialInterface>(O);
		const UMaterial* Base = M ? M->GetMaterial() : nullptr;
		return Base && Base->GetName().Contains(TEXT("M_JsgbScenePost"));
	}
}

bool JsgbPassRunner::CaptureScene(UJsgbSceneMirror& Mirror, const float* D, UTextureRenderTarget2D* Target)
{
	AActor* Owner = Mirror.GetOwner();
	if (!Owner || !Target || Target->SizeX < 1 || Target->SizeY < 1) { return false; }
	USceneCaptureComponent2D* S = PassCapture.Get();
	if (!S || S->GetOwner() != Owner)
	{
		S = NewObject<USceneCaptureComponent2D>(Owner);
		S->bCaptureEveryFrame = false;
		S->bCaptureOnMovement = false;
		S->bAlwaysPersistRenderingState = true;
		S->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
		S->SetupAttachment(Owner->GetRootComponent());
		S->RegisterComponent();
		PassCapture = S;
	}
	S->TextureTarget = Target;
	S->SetWorldLocationAndRotation(Mirror.CameraLocation, Mirror.CameraRotation);
	// The picture keeps the camera's vertical view, as three.js does at the target's aspect.
	const float Aspect = static_cast<float>(Target->SizeX) / Target->SizeY;
	if (D[20] > 0.5f) { S->ProjectionType = ECameraProjectionMode::Orthographic; S->OrthoWidth = D[21] * 2.f * Cm * Aspect; }
	else
	{
		S->ProjectionType = ECameraProjectionMode::Perspective;
		const float VFov = D[16] > 0 ? D[16] : 50.f;
		S->FOVAngle = FMath::RadiansToDegrees(2.f * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(VFov) * 0.5f) * Aspect));
		S->bOverride_CustomNearClippingPlane = D[18] > 0;
		S->CustomNearClippingPlane = D[18] * Cm;
	}
	FPostProcessSettings P = Mirror.Camera ? Mirror.Camera->PostProcessSettings : FPostProcessSettings();
	P.WeightedBlendables.Array.RemoveAll([](const FWeightedBlendable& B) { return !IsScenePost(B.Object); });
	P.bOverride_AutoExposureMethod = true; P.AutoExposureMethod = AEM_Manual;
	P.bOverride_AutoExposureApplyPhysicalCameraExposure = true; P.AutoExposureApplyPhysicalCameraExposure = false;
	// Exposure 1, with the mirror's own calibration (Lumen's offset) as in every other picture of the scene.
	P.bOverride_AutoExposureBias = true; P.AutoExposureBias = Mirror.ExposureOffset;
	P.bOverride_ToneCurveAmount = true; P.ToneCurveAmount = 0.f;
	P.bOverride_BloomIntensity = true; P.BloomIntensity = 0.f;
	P.bOverride_VignetteIntensity = true; P.VignetteIntensity = 0.f;
	P.bOverride_FilmGrainIntensity = true; P.FilmGrainIntensity = 0.f;
	P.bOverride_SceneFringeIntensity = true; P.SceneFringeIntensity = 0.f;
	P.bOverride_LensFlareIntensity = true; P.LensFlareIntensity = 0.f;
	P.bOverride_MotionBlurAmount = true; P.MotionBlurAmount = 0.f;
	S->PostProcessSettings = P;
	S->PostProcessBlendWeight = 1.f;
	S->CaptureSource = ESceneCaptureSource::SCS_FinalColorHDR;
	S->ShowFlags.SetMotionBlur(false); S->ShowFlags.SetBloom(false); S->ShowFlags.SetDepthOfField(false);
	S->ShowFlags.SetVignette(false); S->ShowFlags.SetToneCurve(false); S->ShowFlags.SetLocalExposure(false); S->ShowFlags.SetEyeAdaptation(false);
	// Objects of other render target scenes draw only in their own captures.
	S->HiddenComponents.Reset();
	TInlineComponentArray<UPrimitiveComponent*> Prims(Owner);
	for (UPrimitiveComponent* Prim : Prims) { if (Prim && Prim->bVisibleInSceneCaptureOnly) { S->HiddenComponents.Add(Prim); } }
	// Generated materials the frame uses finish compiling, and every change the frame made reaches the renderer now.
	if (Mirror.CompilingEntities > 0 && GShaderCompilingManager) { GShaderCompilingManager->FinishAllCompilation(); }
	if (UWorld* World = S->GetWorld()) { World->SendAllEndOfFrameUpdates(); }
	S->bCameraCutThisFrame = true;
	for (int32 Pass = 0, N = Passes(); Pass < N; ++Pass) { S->CaptureScene(); }
	return true;
}
