#include "JsgbPointSize.h"

namespace JsgbPointSize
{
	FJsgbPointSize Compute(const FJsgbPointView& View, float Size, bool bSizeAttenuation)
	{
		constexpr double Cm = 100.0;
		FJsgbPointSize Out;
		// three.js attenuates only in a perspective view: gl_PointSize = size * (height / 2) / depth, which is
		// size * tan(fov / 2) world units across at every depth.
		if (bSizeAttenuation && !View.bOrtho)
		{
			Out.Size = static_cast<float>(Size * View.TanHalf * Cm);
			Out.Mode = 0.f;
			return Out;
		}
		// Otherwise the size is in the page's pixels: three draws size * pixelRatio device pixels, and the page
		// runs at a pixel ratio of 1 while Unreal draws PixelScale device pixels for each CSS pixel.
		const double DevicePixels = Size * FMath::Max(1.0, View.PixelScale);
		// An orthographic view has one scale everywhere, so the pixels become a fixed size in cm. The material's
		// pixel mode scales by distance, which only means something in perspective.
		if (View.bOrtho)
		{
			Out.Size = static_cast<float>(DevicePixels * 2.0 * View.OrthoHalfHeightCm / FMath::Max(1.0, View.ViewportHeight));
			Out.Mode = 0.f;
			return Out;
		}
		Out.Size = static_cast<float>(DevicePixels);
		Out.Mode = 1.f;
		return Out;
	}
}
