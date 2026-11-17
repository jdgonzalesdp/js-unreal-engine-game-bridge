#pragma once

#include "CoreMinimal.h"
#include "UObject/GCObject.h"

class UJsgbBridge;
class UJsgbSceneMirror;
class UMaterial;
class UMaterialInstanceDynamic;
class UTexture;
class UTextureRenderTarget2D;
class FJsonObject;

/** A page's full-screen passes into render targets, run when the page reads one of those targets back
 *  (Runtime/src/passRun.ts): a light meter reducing the picture to one pixel, a white-balance patch, a simulation step.
 *  The scenes the passes start from are captured into float targets (PassScene), then each pass's translated shader
 *  draws over its whole target as a material, in the page's order, and the target the page reads comes back as floats
 *  (PassRun). Pass targets keep WebGL's row order: the bottom row of the picture is the first row in memory. */
namespace JsgbPassRunner
{
	/** One bridge's runner: its targets, materials and data textures, kept alive through the collector. Slots are this
	 *  run's targets by number; Kept are results the page may bind again in a later run, by id. */
	class FState : public FGCObject
	{
	public:
		TMap<int32, TObjectPtr<UTextureRenderTarget2D>> Slots, Kept;
		TMap<FString, TSharedPtr<FJsonObject>> Shaders;
		TMap<FString, TObjectPtr<UMaterial>> Materials;
		TSet<FString> Failed;
		TMap<int32, TObjectPtr<UTexture>> Textures;
		/** One instance per pass of a run, reused by the next run while the pass at that place keeps its material. */
		TArray<TObjectPtr<UMaterialInstanceDynamic>> Instances;
		TObjectPtr<UMaterial> Copy;
		TObjectPtr<UMaterialInstanceDynamic> CopyInstance;
		/** The scene capture's own target, and the target an input never drawn reads (zeros, alpha included). */
		TObjectPtr<UTextureRenderTarget2D> Scratch, Zero;
		/** Whether a pass material writes exactly the colour and alpha it computes here: -1 not checked yet. */
		int32 Checked = -1;

		virtual void AddReferencedObjects(FReferenceCollector& Collector) override;
		virtual FString GetReferencerName() const override { return TEXT("JsgbPassRunner"); }
	};
	FState& StateFor(UJsgbBridge* Bridge);

	/** A render target for a slot: Format 0 bytes, 1 half float, 2 float (three's texture types), plus 16 to sample it
	 *  nearest. A target of another size or format is made anew. */
	UTextureRenderTarget2D* Target(TMap<int32, TObjectPtr<UTextureRenderTarget2D>>& Map, int32 Slot, int32 Width, int32 Height, int32 Format);
	/** A data texture (a curve, a lookup table) from its float RGBA pixels (base64), as half floats. */
	void SetTexture(FState& S, const TSharedPtr<FJsonObject>& P);

	/** A pass's shader (Runtime/src/passHlsl.ts) as an unlit surface material drawn over a whole target: a Custom node
	 *  with the HLSL, its colour into emissive and one minus its alpha into opacity, under premultiplied blending. Drawn
	 *  into a target cleared to (0, 0, 0, 1), the target then holds exactly the colour and alpha the pass wrote (alpha
	 *  kept in 0 to 1). Materials compile in editor builds only; elsewhere Error says so. */
	UMaterial* BuildMaterial(const FString& Key, const TSharedPtr<FJsonObject>& Shader, FString& Error);
	/** Copies a scene capture into a pass target: rows turned to WebGL's order, alpha 1. Its texture parameter: Src. */
	UMaterial* CopyMaterial(FString& Error);
	/** Writes the constant (0.25, -0.5, 2, 0.75), to check that a pass material writes what it computes. */
	UMaterial* CheckMaterial(FString& Error);

	/** Draws the frame the mirror just applied from that frame's camera (header layout: Runtime/src/sceneExport.ts) into
	 *  Target, as three draws a scene into a render target: linear light, exposure 1, the scene's background and fog,
	 *  and none of the view's other post-processing. Rows from the top. */
	bool CaptureScene(UJsgbSceneMirror& Mirror, const float* Header, UTextureRenderTarget2D* Target);
}
