#pragma once

#include "CoreMinimal.h"

class UMaterialInterface;

/** three.js draw order, as the mirror follows it (Runtime/src/drawOrder.ts has the reasons).
 *  - Sort priorities: the page sends an 'order' event per object whose rank among this frame's (list, group order,
 *    renderOrder) keys changed. They become the component's translucency sort priority, so two see-through surfaces
 *    at one place (a mark's outline and its fill) draw in three's order instead of swapping from frame to frame.
 *  - Draw-through: a see-through surface with depthTest false or depthFunc AlwaysDepth draws with a copy of its
 *    parent material that skips the depth test, as three draws it over walls and bodies. */
namespace JsgbDrawOrder
{
	/** An 'order' event for entity Id of this mirror. Priority 0 is the default, so it removes the entry. */
	void Note(const UObject* Mirror, int32 Id, int32 Priority);

	/** The priority the page sent for Id, or Fallback when it sent none. */
	int32 Priority(const UObject* Mirror, int32 Id, int32 Fallback);

	/** Forgets this mirror's priorities (the mirror reset). */
	void Reset(const UObject* Mirror);

	/** Parent, or, when bThrough and Parent is a translucent UMaterial, a copy of it that skips the depth test (made
	 *  once per parent, editor builds only: Unreal compiles material copies only there). */
	UMaterialInterface* DepthParent(UMaterialInterface* Parent, bool bThrough);
}
