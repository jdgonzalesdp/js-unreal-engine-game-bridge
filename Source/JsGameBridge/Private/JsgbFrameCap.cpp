// window.jsgb.setFrameRate (Runtime/src/frameRate.ts): the page asks Unreal to present at most this many frames a
// second. The request is kept here; AJsgbHost::Tick applies it to t.MaxFPS on the game thread (JsgbFrameCap.h).
#include "JsgbFrameCap.h"
#include "JsgbBridge.h"

void UJsgbBridge::SetFrameRate(float Fps)
{
	// 0 drops the request. Anything else is held to the range -JsgbSceneFps accepts.
	const float Asked = FMath::IsFinite(Fps) && Fps > 0.f ? FMath::Clamp(Fps, 1.f, 240.f) : 0.f;
	if (AskedFrameRate.exchange(Asked, std::memory_order_relaxed) == Asked) { return; }
	Log(TEXT("log"), Asked > 0.f ? FString::Printf(TEXT("frame rate: the page asks for at most %.3g frames a second"), Asked)
		: FString(TEXT("frame rate: the page dropped its request")));
}

FJsgbFrameCap& JsgbSceneFrameCap()
{
	static FJsgbFrameCap Cap;
	return Cap;
}
