#include "JsgbWasmFeatures.h"
#include "CoreMinimal.h"
#include <mutex>

THIRD_PARTY_INCLUDES_START
#include "v8.h"
THIRD_PARTY_INCLUDES_END

void JsgbEnableWasmFeatures()
{
#if V8_MAJOR_VERSION < 10
	// Worker threads start their isolates on their own threads; the flag is set once, whichever comes first.
	static std::once_flag Once;
	std::call_once(Once, []
	{
		// Reference types shipped in V8 9.6; 9.4 has them complete behind this flag.
		v8::V8::SetFlagsFromString("--experimental-wasm-reftypes");
		UE_LOG(LogTemp, Display, TEXT("JsGameBridge: WebAssembly reference types on for this module's V8 %d.%d"), V8_MAJOR_VERSION, V8_MINOR_VERSION);
	});
#endif
}
