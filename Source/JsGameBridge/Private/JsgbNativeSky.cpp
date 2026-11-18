// Native sun/sky: SkyAtmosphere, an atmosphere sun and a captured sky light, driven by the streamed
// scene quality's resolved sun (Runtime/src/sceneQuality.ts). The shared scene stays canonical — the
// sun's angles, lux and colour temperature arrive from the same saved settings the browser renders;
// Unreal only translates them into its own sky and light. The mirror hides its mirrored main sun
// (the directional travelling along the same direction) and, for a procedural sky, the game's sky
// dome. Practicals and added suns keep mirroring. Inactive until a game streams scene quality.
#include "JsgbHost.h"
#include "JsgbBridge.h"
#include "JsgbSceneMirror.h"
#include "Camera/CameraComponent.h"
#include "HAL/IConsoleManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbNativeSky, Log, All);
DEFINE_LOG_CATEGORY_STATIC(LogJsgbTier, Log, All);

namespace
{
	// PrepViz's sun placement (sunPath.ts sunPositionFromAngles): az 0 at +Z, az 90 at +X, three.js axes.
	FVector SunTravelThree(double AzDeg, double ElDeg)
	{
		const double Az = FMath::DegreesToRadians(AzDeg), El = FMath::DegreesToRadians(ElDeg);
		return FVector(-FMath::Sin(Az) * FMath::Cos(El), -FMath::Sin(El), -FMath::Cos(Az) * FMath::Cos(El));
	}

	// three.js (x, y, z) direction in Unreal axes: the mirror's Dir() swap.
	FVector ToUe(const FVector& Three) { return FVector(Three.X, Three.Z, Three.Y); }

	bool HexColor(const FString& Hex, FLinearColor& Out)
	{
		if (Hex.Len() < 7 || Hex[0] != TEXT('#')) { return false; }
		const FColor Srgb = FColor::FromHex(Hex.Mid(1));
		Out = FLinearColor(Srgb);
		return true;
	}
}

void AJsgbHost::SetupNativeSky()
{
	NativeSun = NewObject<UDirectionalLightComponent>(this);
	NativeSun->SetMobility(EComponentMobility::Movable);
	NativeSun->bAtmosphereSunLight = true;
	NativeSun->AtmosphereSunLightIndex = 0;
	NativeSun->SetCastShadows(true);
	// The fitted cascade setup the mirrored sun uses (JsgbSceneMirror): 150 m in four cascades, small
	// biases, contact shadows to seal wall bases at a grazing sun.
	NativeSun->SetDynamicShadowDistanceMovableLight(15000.f);
	NativeSun->SetDynamicShadowCascades(4);
	NativeSun->SetShadowBias(0.1f);
	NativeSun->SetShadowSlopeBias(0.2f);
	NativeSun->ContactShadowLength = 0.08f;
	NativeSun->SetupAttachment(GetRootComponent());
	NativeSun->RegisterComponent();
	NativeSun->SetVisibility(false);

	NativeAtmosphere = NewObject<USkyAtmosphereComponent>(this);
	NativeAtmosphere->SetMobility(EComponentMobility::Movable);
	NativeAtmosphere->SetupAttachment(GetRootComponent());
	NativeAtmosphere->RegisterComponent();
	NativeAtmosphere->SetVisibility(false);

	NativeSkyLight = NewObject<USkyLightComponent>(this);
	NativeSkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
	NativeSkyLight->bRealTimeCapture = true;
	// The ground's bounce is Lumen's job (stage 4); capturing the peach ground plane into the lower
	// hemisphere washed the whole frame in it on top of PrepViz's own ambient terms.
	NativeSkyLight->bLowerHemisphereIsBlack = true;
	NativeSkyLight->SetIntensity(0.4f);
	NativeSkyLight->SetMobility(EComponentMobility::Movable);
	NativeSkyLight->SetupAttachment(GetRootComponent());
	NativeSkyLight->RegisterComponent();
	NativeSkyLight->SetVisibility(false);
}

void AJsgbHost::UpdateNativeSky()
{
	if (!Bridge || !NativeSun || !Mirror) { return; }
	const FString Json = Bridge->GetSceneQuality();
	if (Json == NativeSkyJson) { return; }
	NativeSkyJson = Json;

	TSharedPtr<FJsonObject> In;
	if (!Json.IsEmpty()) { FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), In); }
	const TSharedPtr<FJsonObject>* SunObj = nullptr;
	if (In) { In->TryGetObjectField(TEXT("sun"), SunObj); }
	const bool bActive = In && SunObj && SunObj->IsValid();
	if (bActive != bNativeSkyActive)
	{
		bNativeSkyActive = bActive;
		UE_LOG(LogJsgbNativeSky, Display, TEXT("native sun/sky %s"), bActive ? TEXT("on: the streamed sun drives SkyAtmosphere") : TEXT("off: mirrored sun and sky"));
	}
	if (!bActive)
	{
		Mirror->bNativeSun = false;
		Mirror->bNativeSky = false;
		NativeSun->SetVisibility(false);
		NativeAtmosphere->SetVisibility(false);
		NativeSkyLight->SetVisibility(false);
		return;
	}

	const TSharedPtr<FJsonObject>& Sun = *SunObj;
	double AzDeg = 0, ElDeg = 45, Lux = 0;
	Sun->TryGetNumberField(TEXT("azDeg"), AzDeg);
	Sun->TryGetNumberField(TEXT("elDeg"), ElDeg);
	Sun->TryGetNumberField(TEXT("lux"), Lux);
	bool bOn = true, bCast = true;
	Sun->TryGetBoolField(TEXT("on"), bOn);
	Sun->TryGetBoolField(TEXT("castShadow"), bCast);
	FString Mode, SkyMode, ColorHex;
	Sun->TryGetStringField(TEXT("mode"), Mode);
	In->TryGetStringField(TEXT("skyMode"), SkyMode);
	// The effective colour (CCT > override > elevation curve, resolved in PrepViz) wins over the raw
	// fields: at magic hour neither is set, and a white native sun washed the whole frame grey.
	if (!Sun->TryGetStringField(TEXT("effectiveColorHex"), ColorHex) || ColorHex.IsEmpty()) { Sun->TryGetStringField(TEXT("colorHex"), ColorHex); }
	double CctK = 0;
	const bool bHasCct = Sun->TryGetNumberField(TEXT("cctK"), CctK);

	const FVector TravelThree = SunTravelThree(AzDeg, ElDeg);
	Mirror->NativeSunDir = TravelThree;
	Mirror->bNativeSun = true;
	// The moon keeps PrepViz's own dome for now: SkyAtmosphere has no moon, and pointing its sun
	// at the moon would light the sky like day. The native directional still replaces the moonlight.
	const bool bSky = SkyMode == TEXT("procedural") && Mode != TEXT("moon");
	Mirror->bNativeSky = bSky;

	NativeSun->SetWorldRotation(ToUe(TravelThree).Rotation());
	NativeSun->SetCastShadows(bCast);
	// PrepViz calibrates three's intensity at lux / 1000; the native sun starts from the same number
	// (times the mirror's SunScale, which Lumen mode raises) so the exposure story does not change.
	NativeSun->SetIntensity(bOn ? float(Lux / 1000.0) * Mirror->SunScale : 0.f);
	FLinearColor Override;
	if (HexColor(ColorHex, Override)) { NativeSun->bUseTemperature = false; NativeSun->SetLightColor(Override); }
	else if (bHasCct && CctK > 0) { NativeSun->SetUseTemperature(true); NativeSun->SetTemperature(float(CctK)); }
	else { NativeSun->bUseTemperature = false; }
	NativeSun->SetVisibility(true);
	NativeAtmosphere->SetVisibility(bSky);
	NativeSkyLight->SetVisibility(true);
	// The captured sky replaces part of PrepViz's flat ambient, so it scales with the streamed
	// ambient (three intensity = lux / 1000) instead of stacking a fixed wash on top of it.
	double AmbientLux = 0;
	const TSharedPtr<FJsonObject>* AmbientObj = nullptr;
	if (In->TryGetObjectField(TEXT("ambient"), AmbientObj) && AmbientObj && AmbientObj->IsValid()) { (*AmbientObj)->TryGetNumberField(TEXT("lux"), AmbientLux); }
	NativeSkyLight->SetIntensity(FMath::Clamp(float(AmbientLux / 1000.0), 0.05f, 0.6f));
	NativeSkyLight->MarkRenderStateDirty();
}

namespace
{
	int32 TierRank(const FString& Tier)
	{
		if (Tier == TEXT("medium")) { return 1; }
		if (Tier == TEXT("high")) { return 2; }
		if (Tier == TEXT("ultra")) { return 3; }
		return 0; // low, and anything unrecognised
	}

	const TCHAR* TierName(int32 Rank)
	{
		static const TCHAR* Names[] = {TEXT("low"), TEXT("medium"), TEXT("high"), TEXT("ultra")};
		return Names[FMath::Clamp(Rank, 0, 3)];
	}

	void SetTierCVar(const TCHAR* Name, const TCHAR* Value)
	{
		if (IConsoleVariable* V = IConsoleManager::Get().FindConsoleVariable(Name)) { V->Set(Value, ECVF_SetByCode); }
	}
}

// Lighting tiers: the streamed quality tier (PrepViz's own low/medium/high/ultra) mapped onto Unreal
// levers, with an fps governor that demotes the effective tier below the chosen one when the frame
// budget slips — the Unreal mirror of the browser's adaptive governor, never a saved look change.
//   ultra/high  Lumen preset "high" (full gathers)
//   medium      Lumen preset "light" (half-resolution gathers and reflections)
//   low         no Lumen; native sun/sky + captured sky light only
// Shadows are cascaded (CSM) at every tier for this game — see the re-assert in ApplyLightingTier.
void AJsgbHost::ApplyLightingTier()
{
	if (LightingTierNow.IsEmpty()) { return; }
	const FString Mode = LightingTierNow == TEXT("ultra") || LightingTierNow == TEXT("high") ? TEXT("high")
		: LightingTierNow == TEXT("medium") ? TEXT("light") : FString();
	if (!Mode.IsEmpty() && bLumenAvailable)
	{
		if (LumenPreset != Mode) { LumenPreset = Mode; if (bLumenOn) { SetLumen(false); } }
		if (!bLumenOn) { SetLumen(true); }
	}
	else if (bLumenOn) { SetLumen(false); }
	// Cascaded shadows for this game (the host config's call): Lumen mode turns VSM on, and VSM
	// never shadowed the floors on the interior set — re-assert CSM after any Lumen switch.
	SetTierCVar(TEXT("r.Shadow.Virtual.Enable"), TEXT("0"));
	// Shadow maps exist at EVERY tier (they are the product): a saved sg.ShadowQuality=0 from
	// handheld-preset runs persisted in the user settings and silently disabled every shadow
	// map in desktop runs — casters, lights and cascades all correct, nothing drawn. Low keeps
	// small maps; it never turns shadows off.
	SetTierCVar(TEXT("sg.ShadowQuality"), LightingTierNow == TEXT("low") ? TEXT("1") : LightingTierNow == TEXT("medium") ? TEXT("2") : TEXT("3"));
	if (Camera)
	{
		FPostProcessSettings& P = Camera->PostProcessSettings;
		const float Q = LightingTierNow == TEXT("ultra") ? 1.f : LightingTierNow == TEXT("high") ? 0.85f : 0.5f;
		P.bOverride_LumenReflectionQuality = bLumenOn;
		P.LumenReflectionQuality = Q;
	}
	UE_LOG(LogJsgbTier, Display, TEXT("lighting tier: chosen %s, effective %s (lumen %s)"), *LightingTier, *LightingTierNow, bLumenOn ? *LumenPreset : TEXT("off"));
	if (Bridge) { Bridge->Log(TEXT("log"), FString::Printf(TEXT("lighting tier %s (chosen %s)"), *LightingTierNow, *LightingTier)); }
}

void AJsgbHost::UpdateLightingTier(float DeltaSeconds)
{
	if (!Bridge) { return; }
	const FString Json = Bridge->GetSceneQuality();
	if (Json != LightingTierJson)
	{
		LightingTierJson = Json;
		FString Tier;
		TSharedPtr<FJsonObject> In;
		if (!Json.IsEmpty() && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), In) && In) { In->TryGetStringField(TEXT("tier"), Tier); }
		if (Tier != LightingTier)
		{
			LightingTier = Tier;
			LightingTierNow = Tier;
			TierEvalSeconds = 0;
			TierAgeSeconds = 0;
			TierGoodWindows = 0;
			TierBadWindows = 0;
			ApplyLightingTier();
		}
	}
	if (LightingTier.IsEmpty()) { return; }
	TierAgeSeconds += DeltaSeconds;
	TierEvalSeconds += DeltaSeconds;
	if (TierEvalSeconds < 2.0) { return; }
	TierEvalSeconds = 0;
	// No demotion while the build is still warming up (shader compiles after a Lumen switch
	// read as low fps for tens of seconds, and demoting then is what flapped the first run).
	if (TierAgeSeconds < 45.0) { return; }
	const int32 Now = TierRank(LightingTierNow), Chosen = TierRank(LightingTier);
	if (HudFps > 0.f && HudFps < 55.f)
	{
		TierGoodWindows = 0;
		// Two bad windows in a row, so one stall (an IndexedDB autosave hitch) cannot cost a rung.
		if (++TierBadWindows >= 2 && Now > 0)
		{
			LightingTierNow = TierName(Now - 1);
			TierBadWindows = 0;
			ApplyLightingTier();
		}
	}
	else if (HudFps >= 59.5f)
	{
		TierBadWindows = 0;
		if (++TierGoodWindows >= 2 && Now < Chosen)
		{
			LightingTierNow = TierName(Now + 1);
			TierGoodWindows = 0;
			ApplyLightingTier();
		}
	}
	else { TierGoodWindows = 0; TierBadWindows = 0; }
}
