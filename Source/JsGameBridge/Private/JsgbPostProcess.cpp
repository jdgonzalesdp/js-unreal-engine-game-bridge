#include "JsgbPostProcess.h"
#include "JsgbPostMaterial.h"
#include "JsgbSceneMirror.h"
#include "JsgbBridge.h"
#include "Camera/CameraComponent.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/Texture2D.h"
#include "Engine/VolumeTexture.h"
#include "Dom/JsonObject.h"
#include "Math/Float16.h"
#include "Misc/Base64.h"
#include "UObject/GCObject.h"
#include "UObject/ObjectKey.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbPost, Log, All);

namespace
{
	/** One mirror's post-processing state. The materials, instances and textures stay alive through the collector. */
	class FJsgbPostPasses : public FGCObject
	{
	public:
		TMap<FString, TSharedPtr<FJsonObject>> Shaders;
		TMap<FString, TObjectPtr<UMaterial>> Materials;
		TSet<FString> Failed;
		/** The chain on the camera now, in order, and the shader key of each. */
		TArray<TObjectPtr<UMaterialInstanceDynamic>> Slots;
		TArray<FString> SlotKeys;
		TMap<int32, TObjectPtr<UTexture>> Textures;

		virtual void AddReferencedObjects(FReferenceCollector& Collector) override
		{
			for (TPair<FString, TObjectPtr<UMaterial>>& M : Materials) { Collector.AddReferencedObject(M.Value); }
			for (TObjectPtr<UMaterialInstanceDynamic>& S : Slots) { Collector.AddReferencedObject(S); }
			for (TPair<int32, TObjectPtr<UTexture>>& T : Textures) { Collector.AddReferencedObject(T.Value); }
		}
		virtual FString GetReferencerName() const override { return TEXT("JsgbPostPasses"); }
	};

	FJsgbPostPasses& StateFor(UJsgbSceneMirror* Mirror)
	{
		static TMap<TObjectKey<UJsgbSceneMirror>, TUniquePtr<FJsgbPostPasses>> All;
		// A mirror that is gone (an ended play session) lets its materials go.
		for (auto It = All.CreateIterator(); It; ++It) { if (!It.Key().ResolveObjectPtr()) { It.RemoveCurrent(); } }
		TUniquePtr<FJsgbPostPasses>& S = All.FindOrAdd(TObjectKey<UJsgbSceneMirror>(Mirror));
		if (!S) { S = MakeUnique<FJsgbPostPasses>(); }
		return *S;
	}

	TextureAddress Address(double Wrap) { return Wrap == 1000 ? TA_Wrap : Wrap == 1002 ? TA_Mirror : TA_Clamp; }

	/** A lookup texture as half-float RGBA (filterable everywhere; 11 bits of mantissa keep a tone curve smooth). */
	void SetTexture(FJsgbPostPasses& S, const TSharedPtr<FJsonObject>& P)
	{
		const int32 Id = static_cast<int32>(P->GetNumberField(TEXT("id")));
		const int32 W = static_cast<int32>(P->GetNumberField(TEXT("width"))), H = static_cast<int32>(P->GetNumberField(TEXT("height")));
		const int32 D = FMath::Max(1, static_cast<int32>(P->GetNumberField(TEXT("depth"))));
		TArray<uint8> Bytes;
		if (W <= 0 || H <= 0 || !FBase64::Decode(P->GetStringField(TEXT("data")), Bytes) || Bytes.Num() < static_cast<int64>(W) * H * D * 16)
		{
			UE_LOG(LogJsgbPost, Warning, TEXT("Post-processing texture %d (%dx%dx%d) arrived without its pixels"), Id, W, H, D);
			return;
		}
		const int64 Count = static_cast<int64>(W) * H * D * 4;
		TArray<FFloat16> Half;
		Half.SetNumUninitialized(Count);
		const float* F = reinterpret_cast<const float*>(Bytes.GetData());
		for (int64 I = 0; I < Count; ++I) { Half[I] = FFloat16(F[I]); }
		const TArrayView64<uint8> Pixels(reinterpret_cast<uint8*>(Half.GetData()), Count * sizeof(FFloat16));
		const TextureFilter Filter = P->GetNumberField(TEXT("nearest")) > 0.5 ? TF_Nearest : TF_Bilinear;
		UTexture* Result = nullptr;
		if (P->GetNumberField(TEXT("volume")) > 0.5)
		{
			FTexturePlatformData* Pd = new FTexturePlatformData();
			Pd->SizeX = W; Pd->SizeY = H; Pd->SetNumSlices(D); Pd->PixelFormat = PF_FloatRGBA;
			FTexture2DMipMap* Mip = new FTexture2DMipMap(W, H, D);
			Pd->Mips.Add(Mip);
			Mip->BulkData.Lock(LOCK_READ_WRITE);
			FMemory::Memcpy(Mip->BulkData.Realloc(Pixels.Num()), Pixels.GetData(), Pixels.Num());
			Mip->BulkData.Unlock();
			UVolumeTexture* V = NewObject<UVolumeTexture>(GetTransientPackage(), NAME_None, RF_Transient);
			V->SetPlatformData(Pd);
			V->SRGB = false; V->Filter = Filter; V->AddressMode = TA_Clamp;
			V->UpdateResource();
			Result = V;
		}
		else if (UTexture2D* T = UTexture2D::CreateTransient(W, H, PF_FloatRGBA, NAME_None, Pixels))
		{
			T->SRGB = false; T->Filter = Filter;
			T->AddressX = Address(P->GetNumberField(TEXT("wrapS"))); T->AddressY = Address(P->GetNumberField(TEXT("wrapT")));
			T->UpdateResource();
			Result = T;
		}
		S.Textures.Add(Id, Result);
	}

	UMaterial* MaterialFor(FJsgbPostPasses& S, UJsgbSceneMirror* Mirror, const FString& Key)
	{
		if (const TObjectPtr<UMaterial>* Found = S.Materials.Find(Key)) { return *Found; }
		if (S.Failed.Contains(Key)) { return nullptr; }
		const TSharedPtr<FJsonObject> Shader = S.Shaders.FindRef(Key);
		if (!Shader) { return nullptr; }
		const double Start = FPlatformTime::Seconds();
		FString Error;
		UMaterial* Mat = JsgbPostMaterial::Build(Key, Shader, Error);
		// Compiling comes off the game clock, as for the scene's generated materials.
		Mirror->StallMs += (FPlatformTime::Seconds() - Start) * 1000.0;
		const FString Name = Shader->GetStringField(TEXT("name"));
		if (!Mat)
		{
			S.Failed.Add(Key);
			UE_LOG(LogJsgbPost, Warning, TEXT("Post-processing %s is left out: %s"), *Name, *Error);
			if (Mirror->Bridge) { Mirror->Bridge->Log(TEXT("warn"), FString::Printf(TEXT("post-processing %s is left out: %s"), *Name, *Error.Left(400))); }
			return nullptr;
		}
		UE_LOG(LogJsgbPost, Display, TEXT("Post-processing %s compiled as a post-process material in %.0f ms"), *Name, (FPlatformTime::Seconds() - Start) * 1000.0);
		S.Materials.Add(Key, Mat);
		return Mat;
	}

	void SetValues(FJsgbPostPasses& S, UMaterialInstanceDynamic* Mid, const TSharedPtr<FJsonObject>& Pass)
	{
		const TSharedPtr<FJsonObject>* Group = nullptr;
		if (Pass->TryGetObjectField(TEXT("scalars"), Group))
		{
			for (const TPair<FString, TSharedPtr<FJsonValue>>& V : (*Group)->Values) { Mid->SetScalarParameterValue(FName(*V.Key), static_cast<float>(V.Value->AsNumber())); }
		}
		if (Pass->TryGetObjectField(TEXT("vectors"), Group))
		{
			for (const TPair<FString, TSharedPtr<FJsonValue>>& V : (*Group)->Values)
			{
				const TArray<TSharedPtr<FJsonValue>>& A = V.Value->AsArray();
				FLinearColor C(0, 0, 0, 0);
				for (int32 I = 0; I < FMath::Min(4, A.Num()); ++I) { C.Component(I) = static_cast<float>(A[I]->AsNumber()); }
				Mid->SetVectorParameterValue(FName(*V.Key), C);
			}
		}
		if (Pass->TryGetObjectField(TEXT("textures"), Group))
		{
			for (const TPair<FString, TSharedPtr<FJsonValue>>& V : (*Group)->Values)
			{
				const TObjectPtr<UTexture>* T = S.Textures.Find(static_cast<int32>(V.Value->AsNumber()));
				if (T && *T) { Mid->SetTextureParameterValue(FName(*V.Key), *T); }
			}
		}
	}

	void SetChain(FJsgbPostPasses& S, UJsgbSceneMirror* Mirror, const TSharedPtr<FJsonObject>& P)
	{
		UCameraComponent* Camera = Mirror->Camera;
		const TArray<TSharedPtr<FJsonValue>>* Passes = nullptr;
		if (!Camera || !P->TryGetArrayField(TEXT("passes"), Passes)) { return; }
		TArray<TObjectPtr<UMaterialInstanceDynamic>> Next;
		TArray<FString> Keys;
		for (const TSharedPtr<FJsonValue>& V : *Passes)
		{
			const TSharedPtr<FJsonObject> Pass = V->AsObject();
			const FString Key = Pass ? Pass->GetStringField(TEXT("key")) : FString();
			UMaterial* Mat = Key.IsEmpty() ? nullptr : MaterialFor(S, Mirror, Key);
			if (!Mat) { continue; }
			// The slot keeps its instance while the same shader stays at that place in the chain.
			const int32 At = Next.Num();
			UMaterialInstanceDynamic* Mid = S.SlotKeys.IsValidIndex(At) && S.SlotKeys[At] == Key ? S.Slots[At].Get() : nullptr;
			// Outer: the transient package. An instance keeps its outer alive, and this state outlives the mirror, so an
			// instance inside the mirror would keep the mirror and its world from ever being collected.
			if (!Mid) { Mid = UMaterialInstanceDynamic::Create(Mat, GetTransientPackage()); }
			SetValues(S, Mid, Pass);
			Next.Add(Mid); Keys.Add(Key);
		}
		// The camera's blendables: the old chain out, the new one in after everything else, so the scene's fog and
		// background material (before depth of field) runs first and these run in the browser's order after it.
		TArray<FWeightedBlendable>& Blendables = Camera->PostProcessSettings.WeightedBlendables.Array;
		Blendables.RemoveAll([&S](const FWeightedBlendable& B) { UObject* O = B.Object; return S.Slots.ContainsByPredicate([O](const TObjectPtr<UMaterialInstanceDynamic>& M) { return M.Get() == O; }); });
		for (const TObjectPtr<UMaterialInstanceDynamic>& Mid : Next) { Blendables.Add(FWeightedBlendable(1.f, Mid.Get())); }
		if (Keys != S.SlotKeys)
		{
			TArray<FString> Names;
			for (const FString& K : Keys) { const TSharedPtr<FJsonObject> Sh = S.Shaders.FindRef(K); Names.Add(Sh ? Sh->GetStringField(TEXT("name")) : K); }
			UE_LOG(LogJsgbPost, Display, TEXT("Post-processing chain: %d pass(es)%s%s"), Names.Num(), Names.Num() ? TEXT(": ") : TEXT(""), *FString::Join(Names, TEXT(", ")));
		}
		S.Slots = MoveTemp(Next);
		S.SlotKeys = MoveTemp(Keys);
	}
}

void JsgbPostProcess::Apply(UJsgbSceneMirror* Mirror, const FString& Kind, const TSharedPtr<FJsonObject>& Event)
{
	const TSharedPtr<FJsonObject>* P = nullptr;
	if (!Mirror || !Event || !Event->TryGetObjectField(TEXT("parameters"), P) || !P || !P->IsValid()) { return; }
	FJsgbPostPasses& S = StateFor(Mirror);
	if (Kind == TEXT("postShader")) { S.Shaders.Add((*P)->GetStringField(TEXT("key")), *P); }
	else if (Kind == TEXT("postTexture")) { SetTexture(S, *P); }
	else if (Kind == TEXT("post")) { SetChain(S, Mirror, *P); }
}
