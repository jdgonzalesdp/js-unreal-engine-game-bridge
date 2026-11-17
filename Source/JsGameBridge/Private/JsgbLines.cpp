#include "JsgbLines.h"
#include "CoreGlobals.h"
#include "EngineDefines.h"

#if !UE_ENABLE_DEBUG_DRAWING
DEFINE_LOG_CATEGORY_STATIC(LogJsgbLines, Log, All);
#endif

namespace
{
	constexpr double Cm = 100.0;
	// A depth-tested line moves toward the camera by this many pixels' worth of depth. Unreal tests it against scene
	// depth upscaled from a lower render resolution, which next to an edge can hold a face sampled about two pixels away.
	constexpr double BiasPixels = 4.0;
	// A face holding a receding line changes depth quickly from pixel to pixel, so the move grows with the line's slope
	// (its depth change per pixel on screen, in pixels' worth), up to this cap. The cap limits how far a line can show
	// through a surface in front of it.
	constexpr double MaxBiasPixels = 16.0;
	// Each later line object moves a little further, to win ties with an equal earlier one as in three.js. This is in
	// pixels and capped, so many line objects never add up to a visible offset.
	constexpr double TiePixels = 0.01;
	constexpr double MaxTiePixels = 1.0;
	// A long perspective line is cut so each piece's far end is at most this much deeper than its near end.
	constexpr double MaxDepthRatio = 1.2;
	// The most pieces one line becomes. Past it the pieces share the depth range evenly, each a little over the ratio.
	constexpr int32 MaxPieces = 24;
	// Pixels added around the frame, besides the line's own width, when finding the part of a line that is in view.
	constexpr double ViewMarginPixels = 8.0;
	constexpr double Tiny = 1e-9;

	double DepthOf(const FJsgbLineView& V, const FVector& P) { return FVector::DotProduct(P - V.Camera, V.Forward); }

	/** How many pixels a depth-tested line moves toward the camera at P, for a line along the unit direction Dir. */
	double BiasAt(const FJsgbLineView& V, const FVector& P, const FVector& Dir)
	{
		const double Dz = FVector::DotProduct(Dir, V.Forward);
		if (FMath::Abs(Dz) < Tiny) { return BiasPixels; }
		// On screen the line runs along Dir less its part that only changes depth. In perspective that part points
		// along the view ray through P.
		FVector Across = Dir - V.Forward * Dz;
		if (!V.bOrtho)
		{
			const FVector Rel = P - V.Camera;
			const double Z = FVector::DotProduct(Rel, V.Forward);
			if (Z < Tiny) { return MaxBiasPixels; }
			Across = Dir - Rel * (Dz / Z);
		}
		const double Run = Across.Size();
		const double Slope = Run > Tiny ? FMath::Abs(Dz) / Run : MaxBiasPixels;
		return FMath::Min(BiasPixels * (1.0 + Slope), MaxBiasPixels);
	}

	/** The part of the segment from A to B that can be in view, as fractions T0 to T1 of the way from A: in front of the
	 *  near clip plane, and inside the cone through the frame's corners widened by Margin pixels. False when no part can be. */
	bool InView(const FJsgbLineView& V, const FVector& A, const FVector& B, double ZNear, double Margin, double& T0, double& T1)
	{
		const FVector P = A - V.Camera, D = B - A;
		const double Z0 = FVector::DotProduct(P, V.Forward), Dz = FVector::DotProduct(D, V.Forward);
		T0 = 0.0;
		T1 = 1.0;
		if (FMath::Abs(Dz) < Tiny) { if (Z0 < ZNear) { return false; } }
		else if (Dz > 0.0) { T0 = FMath::Max(T0, (ZNear - Z0) / Dz); }
		else { T1 = FMath::Min(T1, (ZNear - Z0) / Dz); }
		if (T0 > T1) { return false; }
		if (V.Viewport.X <= 0.0 || V.Viewport.Y <= 0.0) { return true; }
		// Inside the cone: |P + tD|^2 <= K (Z0 + t Dz)^2, a quadratic Qa t^2 + Qb t + Qc <= 0. In front of the camera the
		// cone is convex, so within T0..T1 that holds on one interval.
		const double Tan = V.PixelSize * (0.5 * V.Viewport.Size() + Margin);
		const double K = 1.0 + Tan * Tan;
		const double Qa = D.SizeSquared() - K * Dz * Dz;
		const double Qb = 2.0 * (FVector::DotProduct(P, D) - K * Z0 * Dz);
		const double Qc = P.SizeSquared() - K * Z0 * Z0;
		const double Disc = Qb * Qb - 4.0 * Qa * Qc;
		if (FMath::Abs(Qa) <= Tiny * D.SizeSquared() * K)
		{
			// The line runs along the cone's surface: the test is linear.
			if (FMath::Abs(Qb) <= Tiny) { return Qc <= 0.0; }
			if (Qb > 0.0) { T1 = FMath::Min(T1, -Qc / Qb); } else { T0 = FMath::Max(T0, -Qc / Qb); }
			return T0 <= T1;
		}
		if (Disc < 0.0) { return Qa < 0.0; }
		// Both roots, computed without cancellation.
		const double Q = -0.5 * (Qb + (Qb >= 0.0 ? 1.0 : -1.0) * FMath::Sqrt(Disc));
		double R0 = Q / Qa, R1 = FMath::Abs(Q) > 0.0 ? Qc / Q : R0;
		if (R0 > R1) { Swap(R0, R1); }
		if (Qa > 0.0)
		{
			T0 = FMath::Max(T0, R0);
			T1 = FMath::Min(T1, R1);
			return T0 <= T1;
		}
		// Steeper than the cone: inside before R0 and after R1. Only one side lies in front of the camera, and taking
		// both, if rounding keeps both, can only widen the result.
		const bool bLow = T0 <= FMath::Min(T1, R0), bHigh = FMath::Max(T0, R1) <= T1;
		if (!bLow && !bHigh) { return false; }
		if (!bLow) { T0 = FMath::Max(T0, R1); }
		if (!bHigh) { T1 = FMath::Min(T1, R0); }
		return true;
	}
}

FLinearColor JsgbLines::Color(const FColor& Encoded, float Alpha, bool bOnTop)
{
	const FLinearColor C(Encoded.R / 255.f, Encoded.G / 255.f, Encoded.B / 255.f, Alpha);
#if UE_ENABLE_DEBUG_DRAWING
	// The foreground composite raises the colour to 1/2.2 (PostProcessCompositePrimitives.usf), so it goes in raised
	// to 2.2 and lands on screen as Encoded, like an SDPG_World line.
	return bOnTop ? FLinearColor(FMath::Pow(C.R, 2.2f), FMath::Pow(C.G, 2.2f), FMath::Pow(C.B, 2.2f), Alpha) : C;
#else
	// No foreground composite in this build, so there is nothing to cancel.
	return C;
#endif
}

void JsgbLines::Add(TArray<FBatchedLine>& Out, const FBatchedLine& Line, const FJsgbLineView& View, float Width, bool bWorldWidth, int32 Rank)
{
	FBatchedLine L = Line;
#if !UE_ENABLE_DEBUG_DRAWING
	// Without debug drawing the foreground group is depth-tested as well, so these lines need the same placement.
	if (L.DepthPriority == SDPG_Foreground)
	{
		L.DepthPriority = SDPG_World;
		static bool bWarned = false;
		if (!bWarned)
		{
			bWarned = true;
			UE_LOG(LogJsgbLines, Warning, TEXT("This build has no debug drawing, so lines with depthTest=false are depth-tested like the others"));
		}
	}
#endif
	FVector A = L.Start, B = L.End;
	if (L.DepthPriority == SDPG_World)
	{
		const FVector Dir = (B - A).GetSafeNormal();
		const double Ties = FMath::Min(TiePixels * Rank, MaxTiePixels);
		if (View.bOrtho)
		{
			// Orthographic rays are parallel: move along the view direction by a fixed distance.
			const FVector Shift = View.Forward * ((BiasAt(View, A, Dir) + Ties) * View.PixelSize);
			A -= Shift;
			B -= Shift;
		}
		else
		{
			// Perspective: along the ray to the camera by a share of the depth, since a pixel grows with depth. Each end
			// keeps its own ray, so the line keeps its place on screen even when the two ends move by different shares.
			A += (View.Camera - A) * FMath::Min(0.5, (BiasAt(View, A, Dir) + Ties) * View.PixelSize);
			B += (View.Camera - B) * FMath::Min(0.5, (BiasAt(View, B, Dir) + Ties) * View.PixelSize);
		}
	}
	if (bWorldWidth || View.bOrtho)
	{
		L.Start = A;
		L.End = B;
		L.Thickness = static_cast<float>(bWorldWidth ? Width * Cm : Width * View.PixelSize);
		Out.Add(L);
		return;
	}
	// Perspective with a width in pixels. Unreal keeps a line's world width along its whole length, and its size on
	// screen falls with view depth (Unreal widens each end in the camera plane), so each piece gets the width its deeper
	// end needs.
	const double CmPerDepth = Width * View.PixelSize;
	auto Emit = [&](const FVector& S, const FVector& E, double Depth)
	{
		L.Start = S;
		L.End = E;
		L.Thickness = static_cast<float>(CmPerDepth * Depth);
		Out.Add(L);
	};
	const double ZA = DepthOf(View, A), ZB = DepthOf(View, B);
	const double ZNear = FMath::Max(static_cast<double>(GNearClippingPlane), 0.01);
	// Most edges are short: one piece.
	if (FMath::Min(ZA, ZB) >= ZNear && FMath::Max(ZA, ZB) <= MaxDepthRatio * FMath::Min(ZA, ZB))
	{
		Emit(A, B, FMath::Max(ZA, ZB));
		return;
	}
	double T0 = 0.0, T1 = 1.0;
	if (!InView(View, A, B, ZNear, ViewMarginPixels + Width, T0, T1))
	{
		// Out of view: one piece at the narrowest width, which cannot reach into the frame.
		Emit(A, B, FMath::Max(FMath::Min(ZA, ZB), ZNear));
		return;
	}
	// Depth is linear along the line, so the in-view part is nearest the camera at its end on the shallower side. Cut
	// where the depth has grown by an even ratio, walking out from there. Past the in-view part the line is not seen,
	// so the first piece starts at the line's own end and the last piece ends at the other.
	const double ZT0 = ZA + (ZB - ZA) * T0, ZT1 = ZA + (ZB - ZA) * T1;
	const double Z0 = FMath::Max(FMath::Min(ZT0, ZT1), ZNear), Z1 = FMath::Max(FMath::Max(ZT0, ZT1), Z0);
	const int32 Pieces = FMath::Clamp(FMath::CeilToInt32(FMath::Loge(Z1 / Z0) / FMath::Loge(MaxDepthRatio) - 1e-6), 1, MaxPieces);
	if (Pieces == 1)
	{
		Emit(A, B, Z1);
		return;
	}
	const bool bAFirst = ZA <= ZB;
	const FVector& PNear = bAFirst ? A : B;
	const FVector& PFar = bAFirst ? B : A;
	const double ZN = FMath::Min(ZA, ZB), Span = FMath::Abs(ZB - ZA);
	const double Step = FMath::Pow(Z1 / Z0, 1.0 / Pieces);
	FVector S = PNear;
	double Z = Z0;
	for (int32 I = 1; I <= Pieces; ++I)
	{
		Z = I == Pieces ? Z1 : Z * Step;
		const FVector E = I == Pieces ? PFar : FMath::Lerp(PNear, PFar, (Z - ZN) / Span);
		Emit(S, E, Z);
		S = E;
	}
}
