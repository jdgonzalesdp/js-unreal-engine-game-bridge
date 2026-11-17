// A page's full-screen passes into render targets, run when the page reads one back (JsgbPassRunner.h,
// Runtime/src/passRun.ts). PassScene draws a scene the passes start from into a slot; PassRun draws each pass into its
// slot as a material, in order, and returns the rectangle the page reads: [width int32, height int32] then RGBA floats,
// rows in WebGL's order (the bottom row first).
#include "JsgbPassRunner.h"
#include "JsgbBridge.h"
#include "JsgbSceneMirror.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "Kismet/KismetRenderingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "HAL/Event.h"
#include "HAL/PlatformProcess.h"
#include "TextureResource.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbPasses, Log, All);

namespace
{
	using namespace JsgbPassRunner;

	/** Runs Fn on the game thread, now when this is it, else waiting for it (at most 10 s; JavaScript on its own thread).
	 *  Fn owns what it works on: after a wait that timed out it still runs later. */
	bool OnGameThread(UJsgbBridge& Bridge, TFunction<void()> Fn)
	{
		if (!Bridge.bJsThread || IsInGameThread()) { Fn(); return true; }
		struct FJob { FEvent* Done = FPlatformProcess::GetSynchEventFromPool(true); ~FJob() { FPlatformProcess::ReturnSynchEventToPool(Done); } };
		TSharedRef<FJob, ESPMode::ThreadSafe> Job = MakeShared<FJob, ESPMode::ThreadSafe>();
		Bridge.RunOnGame([Job, Fn = MoveTemp(Fn)]() { Fn(); Job->Done->Trigger(); });
		if (Job->Done->Wait(10000)) { return true; }
		Bridge.Log(TEXT("warn"), TEXT("render target passes: the game thread did not run them within 10 s"));
		return false;
	}

	void Draw(UWorld* World, UTextureRenderTarget2D* Target, UMaterialInterface* Material)
	{
		// Cleared to (0, 0, 0, 1), the target ends up holding the pass's colour and alpha (JsgbPassMaterial.cpp).
		UKismetRenderingLibrary::ClearRenderTarget2D(World, Target, FLinearColor(0, 0, 0, 1));
		UKismetRenderingLibrary::DrawMaterialToRenderTarget(World, Target, Material);
	}

	UMaterial* MaterialFor(FState& S, UJsgbBridge& Bridge, const FString& Key)
	{
		if (const TObjectPtr<UMaterial>* Found = S.Materials.Find(Key)) { return *Found; }
		const TSharedPtr<FJsonObject> Shader = S.Shaders.FindRef(Key);
		if (!Shader || S.Failed.Contains(Key)) { return nullptr; }
		const double Start = FPlatformTime::Seconds();
		FString Error;
		UMaterial* Mat = BuildMaterial(Key, Shader, Error);
		const double Ms = (FPlatformTime::Seconds() - Start) * 1000.0;
		// Compiling comes off the game clock, as for the scene's generated materials.
		if (Bridge.Mirror) { Bridge.Mirror->StallMs += Ms; }
		const FString Name = Shader->GetStringField(TEXT("name"));
		if (!Mat)
		{
			S.Failed.Add(Key);
			Bridge.Log(TEXT("warn"), FString::Printf(TEXT("render target pass %s can't run in Unreal: %s"), *Name, *Error.Left(400)));
			return nullptr;
		}
		UE_LOG(LogJsgbPasses, Display, TEXT("Render target pass %s compiled in %.0f ms"), *Name, Ms);
		S.Materials.Add(Key, Mat);
		return Mat;
	}

	/** Once per bridge: a pass material over a cleared target must write exactly what it computes, alpha included. */
	bool Check(FState& S, UJsgbBridge& Bridge, UWorld* World)
	{
		if (S.Checked >= 0) { return S.Checked > 0; }
		FString Error;
		UMaterial* Mat = CheckMaterial(Error);
		UTextureRenderTarget2D* T = Mat ? Target(S.Slots, -100, 1, 1, 2) : nullptr;
		TArray<FLinearColor> Px;
		if (T) { Draw(World, T, Mat); FTextureRenderTargetResource* Res = T->GameThread_GetRenderTargetResource(); if (Res) { Res->ReadLinearColorPixels(Px); } }
		S.Slots.Remove(-100);
		const FLinearColor Want(0.25f, -0.5f, 2.f, 0.75f), Got = Px.Num() ? Px[0] : FLinearColor(-1, -1, -1, -1);
		S.Checked = Px.Num() && Got.Equals(Want, 1e-3f) ? 1 : 0;
		const FString Line = S.Checked ? TEXT("render target passes: a pass material writes its colour and alpha exactly")
			: FString::Printf(TEXT("render target passes are off: a pass material that writes (0.25, -0.5, 2, 0.75) left (%g, %g, %g, %g)%s%s"),
				Got.R, Got.G, Got.B, Got.A, Error.IsEmpty() ? TEXT("") : TEXT(": "), *Error);
		Bridge.Log(S.Checked ? TEXT("log") : TEXT("warn"), Line);
		return S.Checked > 0;
	}

	/** A slot's target: 0 and up this run's, -1 a target never drawn (zeros, as WebGL reads one), -2 and down a kept one. */
	UTexture* SlotTexture(FState& S, UWorld* World, int32 Slot)
	{
		if (Slot >= 0) { return S.Slots.FindRef(Slot); }
		if (Slot <= -2) { return S.Kept.FindRef(-2 - Slot); }
		if (!S.Zero) { S.Zero = Target(S.Slots, -101, 1, 1, 2 | 16); S.Slots.Remove(-101); UKismetRenderingLibrary::ClearRenderTarget2D(World, S.Zero, FLinearColor(0, 0, 0, 0)); }
		return S.Zero;
	}

	void SetValues(FState& S, UWorld* World, UMaterialInstanceDynamic* Mid, const TSharedPtr<FJsonObject>& Pass, bool& bMissing)
	{
		const TSharedPtr<FJsonObject>* Group = nullptr;
		if (Pass->TryGetObjectField(TEXT("scalars"), Group)) { for (const auto& V : (*Group)->Values) { Mid->SetScalarParameterValue(FName(*V.Key), static_cast<float>(V.Value->AsNumber())); } }
		if (Pass->TryGetObjectField(TEXT("vectors"), Group))
		{
			for (const auto& V : (*Group)->Values)
			{
				const TArray<TSharedPtr<FJsonValue>>& A = V.Value->AsArray();
				FLinearColor C(0, 0, 0, 0);
				for (int32 I = 0; I < FMath::Min(4, A.Num()); ++I) { C.Component(I) = static_cast<float>(A[I]->AsNumber()); }
				Mid->SetVectorParameterValue(FName(*V.Key), C);
			}
		}
		if (Pass->TryGetObjectField(TEXT("textures"), Group)) { for (const auto& V : (*Group)->Values) { if (UTexture* T = S.Textures.FindRef(static_cast<int32>(V.Value->AsNumber()))) { Mid->SetTextureParameterValue(FName(*V.Key), T); } } }
		if (Pass->TryGetObjectField(TEXT("slots"), Group))
		{
			for (const auto& V : (*Group)->Values)
			{
				UTexture* T = SlotTexture(S, World, static_cast<int32>(V.Value->AsNumber()));
				if (T) { Mid->SetTextureParameterValue(FName(*V.Key), T); } else { bMissing = true; }
			}
		}
	}

	void Run(UJsgbBridge& Bridge, UJsgbSceneMirror& Mirror, const FString& Json, TArray<uint8>& Result)
	{
		TSharedPtr<FJsonObject> P;
		UWorld* World = Mirror.GetWorld();
		if (!World || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), P) || !P) { return; }
		FState& S = StateFor(&Bridge);
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (P->TryGetArrayField(TEXT("release"), List)) { for (const auto& V : *List) { S.Kept.Remove(static_cast<int32>(V->AsNumber())); } }
		if (P->TryGetArrayField(TEXT("shaders"), List)) { for (const auto& V : *List) { if (const TSharedPtr<FJsonObject> O = V->AsObject()) { S.Shaders.Add(O->GetStringField(TEXT("key")), O); } } }
		if (P->TryGetArrayField(TEXT("textures"), List)) { for (const auto& V : *List) { if (const TSharedPtr<FJsonObject> O = V->AsObject()) { SetTexture(S, O); } } }
		if (!Check(S, Bridge, World)) { return; }
		if (P->TryGetArrayField(TEXT("slots"), List))
		{
			for (const auto& V : *List)
			{
				const TSharedPtr<FJsonObject> O = V->AsObject();
				if (O) { Target(S.Slots, O->GetIntegerField(TEXT("slot")), O->GetIntegerField(TEXT("width")), O->GetIntegerField(TEXT("height")), O->GetIntegerField(TEXT("format"))); }
			}
		}
		int32 Index = 0;
		if (P->TryGetArrayField(TEXT("passes"), List))
		{
			for (const auto& V : *List)
			{
				const TSharedPtr<FJsonObject> Pass = V->AsObject();
				UMaterial* Mat = Pass ? MaterialFor(S, Bridge, Pass->GetStringField(TEXT("key"))) : nullptr;
				UTextureRenderTarget2D* Dst = Pass ? S.Slots.FindRef(Pass->GetIntegerField(TEXT("slot"))) : nullptr;
				if (!Mat || !Dst) { return; }
				if (!S.Instances.IsValidIndex(Index)) { S.Instances.SetNum(Index + 1); }
				TObjectPtr<UMaterialInstanceDynamic>& Mid = S.Instances[Index++];
				if (!Mid || Mid->Parent != Mat) { Mid = UMaterialInstanceDynamic::Create(Mat, GetTransientPackage()); }
				else { Mid->ClearParameterValues(); }
				bool bMissing = false;
				SetValues(S, World, Mid, Pass, bMissing);
				if (bMissing) { Bridge.Log(TEXT("warn"), TEXT("render target passes: a pass reads a target this run did not draw")); return; }
				Draw(World, Dst, Mid);
			}
		}
		const TSharedPtr<FJsonObject>* Read = nullptr;
		if (!P->TryGetObjectField(TEXT("read"), Read)) { return; }
		UTextureRenderTarget2D* Src = Cast<UTextureRenderTarget2D>(SlotTexture(S, World, (*Read)->GetIntegerField(TEXT("slot"))));
		FTextureRenderTargetResource* Res = Src ? Src->GameThread_GetRenderTargetResource() : nullptr;
		if (!Res) { return; }
		const int32 X = FMath::Clamp((*Read)->GetIntegerField(TEXT("x")), 0, Src->SizeX - 1), Y = FMath::Clamp((*Read)->GetIntegerField(TEXT("y")), 0, Src->SizeY - 1);
		const int32 W = FMath::Clamp((*Read)->GetIntegerField(TEXT("width")), 1, Src->SizeX - X), H = FMath::Clamp((*Read)->GetIntegerField(TEXT("height")), 1, Src->SizeY - Y);
		TArray<FLinearColor> Px;
		if (!Res->ReadLinearColorPixels(Px, FReadSurfaceDataFlags(RCM_MinMax), FIntRect(X, Y, X + W, Y + H)) || Px.Num() != W * H) { return; }
		Result.SetNumUninitialized(8 + W * H * 16);
		FMemory::Memcpy(Result.GetData(), &W, 4); FMemory::Memcpy(Result.GetData() + 4, &H, 4);
		FMemory::Memcpy(Result.GetData() + 8, Px.GetData(), W * H * 16);
		// Results the page may need again stay, by id, after the read.
		if (P->TryGetArrayField(TEXT("keep"), List))
		{
			for (const auto& V : *List)
			{
				const TArray<TSharedPtr<FJsonValue>>& K = V->AsArray();
				TObjectPtr<UTextureRenderTarget2D> T;
				if (K.Num() == 2 && S.Slots.RemoveAndCopyValue(static_cast<int32>(K[0]->AsNumber()), T) && T) { S.Kept.Add(static_cast<int32>(K[1]->AsNumber()), T); }
			}
		}
	}
}

bool UJsgbBridge::PassScene(FArrayBuffer Floats, int32 Count, FArrayBuffer Instances, int32 InstanceFloats, int32 Slot, int32 Width, int32 Height, int32 Format)
{
	const int32 N = FMath::Clamp(Count, 0, static_cast<int32>(Floats.Length / sizeof(float)));
	const int32 NI = FMath::Clamp(InstanceFloats, 0, static_cast<int32>(Instances.Length / sizeof(float)));
	if (!Mirror || N < 22 || Slot < 0) { return false; }
	struct FJob { TArray<float> D, I; bool bOk = false; };
	TSharedRef<FJob, ESPMode::ThreadSafe> Job = MakeShared<FJob, ESPMode::ThreadSafe>();
	Job->D.Append(static_cast<const float*>(Floats.Data), N);
	Job->I.Append(static_cast<const float*>(Instances.Data), NI);
	TWeakObjectPtr<UJsgbBridge> Self(this);
	OnGameThread(*this, [Self, Job, Slot, Width, Height, Format]()
	{
		UJsgbBridge* B = Self.Get();
		UJsgbSceneMirror* M = B ? B->Mirror.Get() : nullptr;
		if (!M) { return; }
		// The picture's frame is applied complete: every queued mesh built and no new object left for a later frame.
		const float Build = M->BuildBudgetMs, Create = M->CreateBudgetMs;
		const bool bDefer = M->bDeferOnGameThread;
		M->BuildBudgetMs = 1.0e9f; M->CreateBudgetMs = 1.0e9f; M->bDeferOnGameThread = false;
		M->ApplyFrame(Job->D.GetData(), Job->D.Num(), Job->I.GetData(), Job->I.Num());
		M->BuildBudgetMs = Build; M->CreateBudgetMs = Create; M->bDeferOnGameThread = bDefer;
		if (M->bInterpolate) { M->Interpolate(1.f, 1.f); }
		FState& S = StateFor(B);
		UWorld* World = M->GetWorld();
		TMap<int32, TObjectPtr<UTextureRenderTarget2D>> Scratch;
		if (S.Scratch) { Scratch.Add(0, S.Scratch); }
		S.Scratch = Target(Scratch, 0, Width, Height, 1);
		FString Error;
		if (!S.Copy) { S.Copy = CopyMaterial(Error); if (!S.Copy) { B->Log(TEXT("warn"), TEXT("render target passes: the scene copy material failed: ") + Error); return; } }
		if (!World || !CaptureScene(*M, Job->D.GetData(), S.Scratch)) { return; }
		if (!S.CopyInstance || S.CopyInstance->Parent != S.Copy) { S.CopyInstance = UMaterialInstanceDynamic::Create(S.Copy, GetTransientPackage()); }
		S.CopyInstance->SetTextureParameterValue(TEXT("Src"), S.Scratch);
		Draw(World, Target(S.Slots, Slot, Width, Height, Format), S.CopyInstance);
		Job->bOk = true;
	});
	return Job->bOk;
}

FArrayBufferValue UJsgbBridge::PassRun(const FString& Json)
{
	struct FJob { FString Json; TArray<uint8> Result; };
	TSharedRef<FJob, ESPMode::ThreadSafe> Job = MakeShared<FJob, ESPMode::ThreadSafe>();
	Job->Json = Json;
	TWeakObjectPtr<UJsgbBridge> Self(this);
	const bool bRan = OnGameThread(*this, [Self, Job]() { UJsgbBridge* B = Self.Get(); if (B && B->Mirror) { Run(*B, *B->Mirror, Job->Json, Job->Result); } });
	FArrayBufferValue Out;
	if (bRan) { Out.Data = MoveTemp(Job->Result); }
	if (!Out.Data.Num()) { UE_LOG(LogJsgbPasses, Warning, TEXT("Render target passes did not run (see the lines above)")); }
	return Out;
}
