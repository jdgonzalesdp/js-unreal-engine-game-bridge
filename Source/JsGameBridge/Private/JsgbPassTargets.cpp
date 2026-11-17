// The runner's state, its render targets and its data textures (JsgbPassRunner.h).
#include "JsgbPassRunner.h"
#include "JsgbBridge.h"
#include "Engine/Texture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/VolumeTexture.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Dom/JsonObject.h"
#include "Math/Float16.h"
#include "Misc/Base64.h"
#include "TextureResource.h"
#include "UObject/ObjectKey.h"
#include "UObject/Package.h"

void JsgbPassRunner::FState::AddReferencedObjects(FReferenceCollector& Collector)
{
	for (TPair<int32, TObjectPtr<UTextureRenderTarget2D>>& T : Slots) { Collector.AddReferencedObject(T.Value); }
	for (TPair<int32, TObjectPtr<UTextureRenderTarget2D>>& T : Kept) { Collector.AddReferencedObject(T.Value); }
	for (TPair<FString, TObjectPtr<UMaterial>>& M : Materials) { Collector.AddReferencedObject(M.Value); }
	for (TPair<int32, TObjectPtr<UTexture>>& T : Textures) { Collector.AddReferencedObject(T.Value); }
	for (TObjectPtr<UMaterialInstanceDynamic>& I : Instances) { Collector.AddReferencedObject(I); }
	Collector.AddReferencedObject(Copy);
	Collector.AddReferencedObject(CopyInstance);
	Collector.AddReferencedObject(Scratch);
	Collector.AddReferencedObject(Zero);
}

JsgbPassRunner::FState& JsgbPassRunner::StateFor(UJsgbBridge* Bridge)
{
	static TMap<TObjectKey<UJsgbBridge>, TUniquePtr<FState>> All;
	// A bridge that is gone (a reload, an ended play session) lets its targets and materials go.
	for (auto It = All.CreateIterator(); It; ++It) { if (!It.Key().ResolveObjectPtr()) { It.RemoveCurrent(); } }
	TUniquePtr<FState>& S = All.FindOrAdd(TObjectKey<UJsgbBridge>(Bridge));
	if (!S) { S = MakeUnique<FState>(); }
	return *S;
}

UTextureRenderTarget2D* JsgbPassRunner::Target(TMap<int32, TObjectPtr<UTextureRenderTarget2D>>& Map, int32 Slot, int32 Width, int32 Height, int32 Format)
{
	const EPixelFormat Pf = (Format & 15) == 2 ? PF_A32B32G32R32F : (Format & 15) == 0 ? PF_B8G8R8A8 : PF_FloatRGBA;
	const TextureFilter Filter = (Format & 16) ? TF_Nearest : TF_Bilinear;
	Width = FMath::Clamp(Width, 1, 8192); Height = FMath::Clamp(Height, 1, 8192);
	TObjectPtr<UTextureRenderTarget2D>& T = Map.FindOrAdd(Slot);
	if (!T || T->SizeX != Width || T->SizeY != Height || T->GetFormat() != Pf || T->Filter != Filter)
	{
		// Outer: the transient package, so a target never keeps a world alive.
		T = NewObject<UTextureRenderTarget2D>(GetTransientPackage(), NAME_None, RF_Transient);
		T->ClearColor = FLinearColor(0, 0, 0, 1);
		T->Filter = Filter;
		T->AddressX = TA_Clamp; T->AddressY = TA_Clamp;
		T->InitCustomFormat(Width, Height, Pf, true);
		T->UpdateResourceImmediate(true);
	}
	return T;
}

namespace
{
	TextureAddress Address(double Wrap) { return Wrap == 1000 ? TA_Wrap : Wrap == 1002 ? TA_Mirror : TA_Clamp; }
}

void JsgbPassRunner::SetTexture(FState& S, const TSharedPtr<FJsonObject>& P)
{
	const int32 Id = static_cast<int32>(P->GetNumberField(TEXT("id")));
	const int32 W = static_cast<int32>(P->GetNumberField(TEXT("width"))), H = static_cast<int32>(P->GetNumberField(TEXT("height")));
	const int32 D = FMath::Max(1, static_cast<int32>(P->GetNumberField(TEXT("depth"))));
	TArray<uint8> Bytes;
	if (W <= 0 || H <= 0 || !FBase64::Decode(P->GetStringField(TEXT("data")), Bytes) || Bytes.Num() < static_cast<int64>(W) * H * D * 16) { return; }
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
	if (Result) { S.Textures.Add(Id, Result); }
}
