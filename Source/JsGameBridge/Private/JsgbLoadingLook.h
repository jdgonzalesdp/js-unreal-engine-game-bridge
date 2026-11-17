#pragma once

#include "CoreMinimal.h"

struct FSlateDynamicImageBrush;

/** One image of the loading screen: a PNG drawn at a height in points, optionally repainted in one colour. */
struct FJsgbLoadingImage
{
	/** Absolute path of the PNG, or empty for none. */
	FString File;
	/** Drawn height in points. */
	float Height = 0.f;
	/** Repaints a one-colour mark (ink on transparent) in this colour, keeping its alpha. */
	TOptional<FColor> Tint;
	/** Made by FJsgbLoadingLook::MakeBrushes; null when the image is missing or unreadable. */
	TSharedPtr<FSlateDynamicImageBrush> Brush;
};

/** The loading screen's look: "loading" in publication.json (written by Tools/loading-screen.mjs) over the host's own
 *  look, which a game without it keeps. */
struct FJsgbLoadingLook
{
	FLinearColor Background = FLinearColor(0.02f, 0.025f, 0.035f, 1.f);
	FString Title;
	FLinearColor TitleColor = FLinearColor(0.92f, 0.94f, 0.97f);
	/** A wordmark image drawn instead of the title. */
	FJsgbLoadingImage Logo;
	/** A short line under the name ("from"), and a mark after it. */
	FString Byline;
	FLinearColor BylineColor = FLinearColor(0.6f, 0.65f, 0.72f);
	FJsgbLoadingImage BylineLogo;
	/** The moving bar. */
	FLinearColor Accent = FLinearColor(0.49f, 0.78f, 1.f);
	/** The files and shaders line. */
	FLinearColor StatusColor = FLinearColor(0.6f, 0.65f, 0.72f);

	/** Reads <GameDir>/publication.json. The title falls back to DefaultTitle, then to "Loading". */
	static FJsgbLoadingLook Load(const FString& GameDir, const FString& DefaultTitle);

	/** Decodes the images and makes their brushes, sized in points and resampled to PixelScale pixels per point, so
	 *  each draws one texel per screen pixel (crisp on Retina). Game thread. */
	void MakeBrushes(float PixelScale);
};

/** "#rgb", "#rrggbb" or "#rrggbbaa" (sRGB) as a colour; false when Text is none of them. */
bool JsgbParseLoadingColor(const FString& Text, FColor& Out);
