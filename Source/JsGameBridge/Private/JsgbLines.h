#pragma once

#include "CoreMinimal.h"
#include "Components/LineBatchComponent.h"

/** The camera as the shared line batch needs it for one frame. */
struct FJsgbLineView
{
	FVector Camera = FVector::ZeroVector;
	/** Where the camera looks, unit length. */
	FVector Forward = FVector::ForwardVector;
	bool bOrtho = false;
	/** The world size of one screen pixel: per centimetre of view depth with perspective, in centimetres when orthographic. */
	double PixelSize = 0.0;
	/** The view's size in pixels. Zero when unknown: long lines are then cut for all their depth in front of the camera,
	 *  not only for the part in view. */
	FVector2D Viewport = FVector2D::ZeroVector;
};

/** How three.js line objects (LineSegments, Line2) become Unreal batched lines.
 *
 *  In a Development build Unreal draws a line batch after the tone mapper, at output resolution:
 *  - SDPG_World lines are tested against the scene depth, upscaled from the lower render resolution.
 *  - SDPG_Foreground lines draw on top of everything, through a composite that raises their colour to 1/2.2.
 *  So a line with three.js depthTest=false goes on top (SDPG_Foreground, colour pre-darkened to cancel the 1/2.2),
 *  and every other line is placed so the faces it traces cannot hide it.
 *  Shipping and Test builds have no debug drawing: lines draw in the base pass, where the foreground group is
 *  depth-tested too. There every line is placed as a depth-tested one and keeps its colour as given. */
namespace JsgbLines
{
	/** The batch colour for a line whose on-screen colour is Encoded (sRGB) at the given opacity. */
	FLinearColor Color(const FColor& Encoded, float Alpha, bool bOnTop);

	/** Appends Line to Out, ready to draw this frame:
	 *  - Width is in pixels, or in centimetres when bWorldWidth.
	 *  - Rank is the line object's place in draw order (1 = drawn first).
	 *  - A depth-tested line moves toward the camera along its view rays, so it keeps its pixels on screen and wins the
	 *    depth test against the faces it lies on. The move is a few pixels' worth of depth, more for a line that
	 *    recedes steeply (the faces around it do too), and capped.
	 *  - A long line seen in perspective is cut into pieces, walking out from its part nearest the camera, so each
	 *    piece's far end is at most 1.2 times deeper than its near end (up to 24 pieces, past which the ratio grows a
	 *    little). Each piece is as wide as its far end needs:
	 *    no part drops below Width pixels, and the near ends stay close to it. */
	void Add(TArray<FBatchedLine>& Out, const FBatchedLine& Line, const FJsgbLineView& View, float Width, bool bWorldWidth, int32 Rank);
}
