// How the scene mirror sizes a THREE.Points sprite, the way three.js's points shader does.
#pragma once

#include "CoreMinimal.h"

/** The view a frame's points are drawn into. */
struct FJsgbPointView
{
	bool bOrtho = false;
	/** Half the visible height of an orthographic view, in cm. */
	double OrthoHalfHeightCm = 0;
	/** tan(vertical field of view / 2) of a perspective view. */
	double TanHalf = 0.5;
	/** The view's height in device pixels. */
	double ViewportHeight = 1;
	/** Device pixels per CSS pixel: 2 on a Retina Mac. */
	double PixelScale = 1;
};

/** What the billboard material reads from custom primitive data: Size across, and Mode 0 (Size in cm) or
 *  Mode 1 (Size in device pixels; the material turns pixels into cm by the sprite's distance). */
struct FJsgbPointSize
{
	float Size = 0;
	float Mode = 0;
};

namespace JsgbPointSize
{
	/** Size: PointsMaterial.size as the page sent it. bSizeAttenuation: PointsMaterial.sizeAttenuation. */
	FJsgbPointSize Compute(const FJsgbPointView& View, float Size, bool bSizeAttenuation);
}
