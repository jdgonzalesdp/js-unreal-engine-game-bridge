// Pictures of a scene frame drawn now (Runtime/src/readback.ts, canvasRead.ts). The page draws a scene into a render
// target and reads the pixels back in the same call (an export, a thumbnail, a canvas saved as an image). The runtime
// sends that scene as a frame of its own; here it is applied in full, and a scene capture draws it from its camera,
// with the game view's post-processing, and reads it back before returning. The next ordinary frame puts the game's
// own view back before Unreal draws the screen.
#include "JsgbBridge.h"
#include "JsgbSceneMirror.h"
#include "Camera/CameraComponent.h"
#include "Components/PrimitiveComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/Event.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "ShaderCompiler.h"
#include "TextureResource.h"

namespace
{
	constexpr float Cm = 100.f;
	/** Temporal anti-aliasing (TAA, TSR) needs a few frames of history: each picture is then drawn this many times after a
	 *  camera cut. Other methods need one. */
	int32 Passes()
	{
		const IConsoleVariable* Aa = IConsoleManager::Get().FindConsoleVariable(TEXT("r.AntiAliasingMethod"));
		const int32 Method = Aa ? Aa->GetInt() : 0;
		return Method == 2 || Method == 4 ? 6 : 1;
	}
	TWeakObjectPtr<USceneCaptureComponent2D> ViewCapture;

	USceneCaptureComponent2D* CaptureComponent(UJsgbSceneMirror& Mirror, int32 Width, int32 Height)
	{
		AActor* Owner = Mirror.GetOwner();
		if (!Owner) { return nullptr; }
		USceneCaptureComponent2D* S = ViewCapture.Get();
		if (!S || S->GetOwner() != Owner)
		{
			S = NewObject<USceneCaptureComponent2D>(Owner);
			S->bCaptureEveryFrame = false;
			S->bCaptureOnMovement = false;
			S->bAlwaysPersistRenderingState = true;
			S->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
			S->SetupAttachment(Owner->GetRootComponent());
			S->RegisterComponent();
			ViewCapture = S;
		}
		UTextureRenderTarget2D* T = S->TextureTarget;
		if (!T)
		{
			// Linear half floats: the bytes are encoded once, below, as the screen encodes them.
			T = NewObject<UTextureRenderTarget2D>(S);
			T->ClearColor = FLinearColor::Black;
			T->InitCustomFormat(Width, Height, PF_FloatRGBA, true);
			T->UpdateResourceImmediate(true);
			S->TextureTarget = T;
		}
		else if (T->SizeX != Width || T->SizeY != Height) { T->ResizeTarget(Width, Height); }
		return S;
	}

	/** Draws the frame the mirror just applied from that frame's camera (header layout: sceneExport.ts). */
	bool CaptureNow(UJsgbSceneMirror& Mirror, const float* D, int32 Width, int32 Height, bool bFloat, TArray<uint8>& Out)
	{
		USceneCaptureComponent2D* S = CaptureComponent(Mirror, Width, Height);
		if (!S || !S->TextureTarget) { return false; }
		S->SetWorldLocationAndRotation(Mirror.CameraLocation, Mirror.CameraRotation);
		// The picture keeps the camera's vertical view, as three.js does at the target's aspect.
		const float Aspect = static_cast<float>(Width) / Height;
		if (D[20] > 0.5f) { S->ProjectionType = ECameraProjectionMode::Orthographic; S->OrthoWidth = D[21] * 2.f * Cm * Aspect; }
		else
		{
			S->ProjectionType = ECameraProjectionMode::Perspective;
			const float VFov = D[16] > 0 ? D[16] : 50.f;
			S->FOVAngle = FMath::RadiansToDegrees(2.f * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(VFov) * 0.5f) * Aspect));
			S->bOverride_CustomNearClippingPlane = D[18] > 0;
			S->CustomNearClippingPlane = D[18] * Cm;
		}
		// The game view's post-processing: exposure, tone curve, bloom, and the scene material (background and fog).
		if (Mirror.Camera) { S->PostProcessSettings = Mirror.Camera->PostProcessSettings; S->PostProcessBlendWeight = Mirror.Camera->PostProcessBlendWeight; }
		// Bytes are the picture as the screen shows it (with the tone curve); floats are linear, as a float target holds them.
		S->CaptureSource = bFloat ? ESceneCaptureSource::SCS_FinalColorHDR : ESceneCaptureSource::SCS_FinalToneCurveHDR;
		S->ShowFlags.SetMotionBlur(false);
		// Objects of other render target scenes draw only in their own captures.
		S->HiddenComponents.Reset();
		TInlineComponentArray<UPrimitiveComponent*> Prims(Mirror.GetOwner());
		for (UPrimitiveComponent* P : Prims) { if (P && P->bVisibleInSceneCaptureOnly) { S->HiddenComponents.Add(P); } }
		// Generated materials the frame uses finish compiling, and every change the frame made reaches the renderer now.
		if (Mirror.CompilingEntities > 0 && GShaderCompilingManager) { GShaderCompilingManager->FinishAllCompilation(); }
		if (UWorld* World = S->GetWorld()) { World->SendAllEndOfFrameUpdates(); }
		S->bCameraCutThisFrame = true;
		for (int32 Pass = 0, N = Passes(); Pass < N; ++Pass) { S->CaptureScene(); }
		FTextureRenderTargetResource* Res = S->TextureTarget->GameThread_GetRenderTargetResource();
		TArray<FLinearColor> Px;
		if (!Res || !Res->ReadLinearColorPixels(Px) || Px.Num() != Width * Height) { return false; }
		const int32 N = Px.Num();
		Out.SetNumUninitialized(8 + N * (bFloat ? 16 : 4));
		FMemory::Memcpy(Out.GetData(), &Width, 4); FMemory::Memcpy(Out.GetData() + 4, &Height, 4);
		if (bFloat)
		{
			for (FLinearColor& C : Px) { C.A = 1.f; }
			FMemory::Memcpy(Out.GetData() + 8, Px.GetData(), N * 16);
			return true;
		}
		uint8* B = Out.GetData() + 8;
		for (int32 I = 0; I < N; ++I, B += 4) { const FColor C = Px[I].ToFColorSRGB(); B[0] = C.R; B[1] = C.G; B[2] = C.B; B[3] = 255; }
		return true;
	}
}

FArrayBufferValue UJsgbBridge::CaptureView(FArrayBuffer Floats, int32 Count, FArrayBuffer Instances, int32 InstanceFloats, int32 Width, int32 Height, bool bFloat)
{
	FArrayBufferValue Out;
	const int32 N = FMath::Clamp(Count, 0, static_cast<int32>(Floats.Length / sizeof(float)));
	const int32 NI = FMath::Clamp(InstanceFloats, 0, static_cast<int32>(Instances.Length / sizeof(float)));
	if (!Mirror || N < 22 || Width < 1 || Height < 1) { return Out; }
	Width = FMath::Min(Width, 8192); Height = FMath::Min(Height, 8192);
	auto Run = [this, Width, Height, bFloat](const float* D, int32 DN, const float* Inst, int32 InstN, TArray<uint8>& Result)
	{
		if (!Mirror) { return; }
		// The picture's frame is applied complete: every queued mesh built and no new object left for a later frame.
		const float Build = Mirror->BuildBudgetMs, Create = Mirror->CreateBudgetMs;
		const bool bDefer = Mirror->bDeferOnGameThread;
		Mirror->BuildBudgetMs = 1.0e9f; Mirror->CreateBudgetMs = 1.0e9f; Mirror->bDeferOnGameThread = false;
		Mirror->ApplyFrame(D, DN, Inst, InstN);
		Mirror->BuildBudgetMs = Build; Mirror->CreateBudgetMs = Create; Mirror->bDeferOnGameThread = bDefer;
		// Objects that glide between snapshots (JavaScript on its own thread) are put where this frame has them.
		if (Mirror->bInterpolate) { Mirror->Interpolate(1.f, 1.f); }
		if (!CaptureNow(*Mirror, D, Width, Height, bFloat, Result)) { Result.Reset(); }
	};
	if (!bJsThread || IsInGameThread())
	{
		Run(static_cast<const float*>(Floats.Data), N, static_cast<const float*>(Instances.Data), NI, Out.Data);
		return Out;
	}
	// JavaScript on its own thread: the game thread draws the picture, and this thread waits for it (at most 10 s).
	struct FJob
	{
		TArray<float> D, I;
		TArray<uint8> Result;
		FEvent* Done = FPlatformProcess::GetSynchEventFromPool(true);
		~FJob() { FPlatformProcess::ReturnSynchEventToPool(Done); }
	};
	TSharedRef<FJob, ESPMode::ThreadSafe> Job = MakeShared<FJob, ESPMode::ThreadSafe>();
	Job->D.Append(static_cast<const float*>(Floats.Data), N);
	Job->I.Append(static_cast<const float*>(Instances.Data), NI);
	RunOnGame([Job, Run]() { Run(Job->D.GetData(), Job->D.Num(), Job->I.GetData(), Job->I.Num(), Job->Result); Job->Done->Trigger(); });
	if (Job->Done->Wait(10000)) { Out.Data = MoveTemp(Job->Result); }
	else { Log(TEXT("warn"), TEXT("scene picture: the game thread did not draw it within 10 s")); }
	return Out;
}
