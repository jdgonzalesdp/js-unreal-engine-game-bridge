#include "JsgbDrawOrder.h"

#include "Materials/Material.h"
#include "MaterialShared.h"
#include "UObject/ObjectKey.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace
{
	/** Sort priorities per mirror, by entity id. Only objects whose priority is not 0 have an entry. */
	TMap<FObjectKey, TMap<int32, int32>>& Orders()
	{
		static TMap<FObjectKey, TMap<int32, int32>> Map;
		return Map;
	}

	/** Depth-test-free copies, by the parent they copy. Held strongly: no UPROPERTY points at them. */
	TMap<FObjectKey, TStrongObjectPtr<UMaterial>>& Copies()
	{
		static TMap<FObjectKey, TStrongObjectPtr<UMaterial>> Map;
		return Map;
	}
}

void JsgbDrawOrder::Note(const UObject* Mirror, int32 Id, int32 Priority)
{
	// Unreal keeps the priority in 16 bits of the translucent sort key.
	Priority = FMath::Clamp(Priority, -32000, 32000);
	if (Priority == 0)
	{
		if (TMap<int32, int32>* Ids = Orders().Find(FObjectKey(Mirror))) { Ids->Remove(Id); }
		return;
	}
	Orders().FindOrAdd(FObjectKey(Mirror)).Add(Id, Priority);
}

int32 JsgbDrawOrder::Priority(const UObject* Mirror, int32 Id, int32 Fallback)
{
	const TMap<int32, int32>* Ids = Orders().Find(FObjectKey(Mirror));
	const int32* P = Ids ? Ids->Find(Id) : nullptr;
	return P ? *P : Fallback;
}

void JsgbDrawOrder::Reset(const UObject* Mirror)
{
	Orders().Remove(FObjectKey(Mirror));
}

UMaterialInterface* JsgbDrawOrder::DepthParent(UMaterialInterface* Parent, bool bThrough)
{
#if WITH_EDITOR
	UMaterial* Source = bThrough ? Cast<UMaterial>(Parent) : nullptr;
	// Unreal skips the depth test only for see-through blend modes; an opaque surface keeps it.
	if (!Source || Source->bDisableDepthTest || !IsTranslucentBlendMode(*Source)) { return Parent; }
	if (TStrongObjectPtr<UMaterial>* Found = Copies().Find(FObjectKey(Source)))
	{
		if (Found->IsValid()) { return Found->Get(); }
	}
	UMaterial* Copy = DuplicateObject<UMaterial>(Source, GetTransientPackage());
	Copy->bDisableDepthTest = true;
	Copy->ForceRecompileForRendering(EMaterialShaderPrecompileMode::None);
	Copies().Add(FObjectKey(Source), TStrongObjectPtr<UMaterial>(Copy));
	return Copy;
#else
	return Parent;
#endif
}
