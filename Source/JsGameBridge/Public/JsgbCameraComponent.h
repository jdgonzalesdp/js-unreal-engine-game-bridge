#pragma once

#include "CoreMinimal.h"
#include "Camera/CameraComponent.h"
#include "JsgbCameraComponent.generated.h"

/** The host camera, with the page view's off-centre projection.
 *
 *  The page camera owns only its canvas rectangle of the window; the mirror renders an expanded
 *  full-window frustum (Runtime viewRect record) and shifts its centre onto that rectangle through
 *  FMinimalViewInfo::OffCenterProjectionOffset, which UCameraComponent does not export. The offset
 *  is the page centre in window NDC; the engine shears by its negation (CameraStackTypes
 *  CalculateProjectionMatrix), so the sign flips here. */
UCLASS()
class JSGAMEBRIDGE_API UJsgbCameraComponent : public UCameraComponent
{
	GENERATED_BODY()

public:
	/** The page centre in window NDC (x right, y up); zero centres the projection. Set per frame. */
	FVector2D ViewCenterNdc = FVector2D::ZeroVector;

	virtual void GetCameraView(float DeltaTime, FMinimalViewInfo& DesiredView) override
	{
		Super::GetCameraView(DeltaTime, DesiredView);
		DesiredView.OffCenterProjectionOffset = FVector2D(-ViewCenterNdc.X, -ViewCenterNdc.Y);
	}
};
