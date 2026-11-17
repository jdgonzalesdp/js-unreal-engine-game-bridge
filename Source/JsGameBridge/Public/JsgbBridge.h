#pragma once

#include "CoreMinimal.h"
#include <source_location>
#include "UObject/Object.h"
#include "ArrayBuffer.h"
#include "JsgbCameraRig.h"
#include "JsgbBridge.generated.h"

class UJsgbSceneMirror;
class UJsgbAudio;

DECLARE_DYNAMIC_DELEGATE_OneParam(FJsgbFrameDelegate, float, BudgetMs);
DECLARE_DYNAMIC_DELEGATE_OneParam(FJsgbStringDelegate, const FString&, Json);
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FJsgbKeyDelegate, const FString&, Type, const FString&, Code, bool, bRepeat);
DECLARE_DYNAMIC_DELEGATE_SevenParams(FJsgbMouseDelegate, const FString&, Type, float, X, float, Y, int32, Button, int32, Buttons, float, DX, float, DY);
DECLARE_DYNAMIC_DELEGATE_OneParam(FJsgbWheelDelegate, float, DeltaY);
DECLARE_DYNAMIC_DELEGATE_TwoParams(FJsgbViewportDelegate, int32, Width, int32, Height);
DECLARE_DYNAMIC_DELEGATE_RetVal_OneParam(FString, FJsgbEvalDelegate, const FString&, Source);

/** The object the bundled web game talks to through `globalThis.__jsgbHost` (see
 *  JavaScript/jsgb-main.js): files, time, logs, saves, the scene sink, the UI snapshot and audio.
 *  No game rules live here. */
UCLASS()
class JSGAMEBRIDGE_API UJsgbBridge : public UObject
{
	GENERATED_BODY()
public:
	// Bound from JavaScript.
	UPROPERTY() FJsgbFrameDelegate OnFrame;
	UPROPERTY() FJsgbStringDelegate OnUIInput;
	UPROPERTY() FJsgbKeyDelegate OnKey;
	UPROPERTY() FJsgbMouseDelegate OnMouse;
	UPROPERTY() FJsgbWheelDelegate OnWheel;
	UPROPERTY() FJsgbViewportDelegate OnViewport;
	UPROPERTY() FJsgbStringDelegate OnGamepads;
	UPROPERTY() FJsgbEvalDelegate OnEval;
	/** Restarts the page at a path and query on its origin (a sign-in coming back from the system browser). */
	UPROPERTY() FJsgbStringDelegate OnNavigate;

	/** location.search the game boots with (e.g. "?play"). */
	UPROPERTY() FString Search;
	/** The page's origin ("http://localhost:5180") and location.pathname (PagePath) at this start (JsgbAddress.cpp). */
	UPROPERTY() FString Origin;
	UPROPERTY() FString PagePath = TEXT("/");
	/** -JsgbTraceMirror: the runtime logs each object's type, name and uuid the first time it is drawn. */
	UPROPERTY() bool Trace = false;
	/** The merged asset registry JSON the build wrote. */
	UPROPERTY() FString Registry;
	/** Math.random seed for deterministic captures (-JsgbSeed=); 0 keeps it random. */
	UPROPERTY() int32 Seed = 0;
	/** Absolute path of the bundle (.mjs). */
	UPROPERTY() FString BundlePath;
	/** navigator.platform for the game: "MacIntel" on a Mac, so it picks ⌘ shortcuts as in a Mac browser. */
	UPROPERTY() FString Platform = PLATFORM_MAC ? TEXT("MacIntel") : PLATFORM_LINUX ? TEXT("Linux x86_64") : TEXT("Win32");

	// Platform services.
	/** Secure random bytes for crypto.getRandomValues, and network requests for fetch() to the origins the game may
	 *  reach (JsgbNet.cpp, Runtime/src/netFetch.ts). HttpStart returns 0 for a refused URL; HttpTake is empty until the
	 *  reply is in. */
	UFUNCTION() FArrayBufferValue RandomBytes(int32 Count);
	UFUNCTION() int32 HttpStart(const FString& Method, const FString& Url, const FString& HeadersJson, FArrayBuffer Body);
	UFUNCTION() FArrayBufferValue HttpTake(int32 Id);
	/** Streamed requests for the page's fetch (JsgbNetStream.cpp, Runtime/src/fetchStream.ts): HttpStream starts one (0 for
	 *  a refused URL), HttpRead is empty until something new has arrived, HttpCancel ends it. */
	UFUNCTION() int32 HttpStream(const FString& Method, const FString& Url, const FString& HeadersJson, FArrayBuffer Body);
	UFUNCTION() FArrayBufferValue HttpRead(int32 Id);
	UFUNCTION() void HttpCancel(int32 Id);
	/** The origins fetch() may reach, for the page and its workers: the game's netAllow (publication.json beside
	 *  BundlePath) and -JsgbNetAllow=. */
	void ConfigureNet();
	/** Origin, PagePath and Search for this start: publication.json "origin" or -JsgbOrigin=, and the address the page had
	 *  when it last restarted (SetAddress). */
	void ConfigureAddress();
	/** The path and query the page starts at next time, and an http(s) URL for the system browser (JsgbAddress.cpp). */
	UFUNCTION() void SetAddress(const FString& PathAndQuery);
	UFUNCTION() bool OpenExternal(const FString& Url);

	UFUNCTION() FArrayBufferValue ReadFile(const FString& Path);
	/** The display (window.jsgb.display): the monitor's resolutions as JSON [{width, height, refresh}], the current settings
	 *  as JSON {width, height, mode, vsync, maxFps}, and a change ({width?, height?, mode?, vsync?, maxFps?}) applied on
	 *  the game thread. mode is "windowed", "borderless" or "fullscreen"; maxFps 0 means no cap. */
	UFUNCTION() FString DisplayModes();
	UFUNCTION() FString DisplayGet();
	UFUNCTION() void DisplaySet(const FString& Json);
	/** Refreshes the display JSON the JavaScript thread reads. Game thread. */
	void UpdateDisplayInfo();
	/** Where this game's display settings are kept (Saved/JsGameBridge/<game>/display.json): each game keeps its own,
	 *  and Unreal's shared settings file isn't written. */
	FString DisplayFile;
	/** The game's display.json (or a display set since) has a frame cap the player chose, unlimited (0) included. */
	bool bSavedFrameCap = false;
	/** window.jsgb.setFrameRate: the most frames a second the page asks Unreal to present, 0 for no request. Any thread
	 *  sets it; AJsgbHost::Tick applies it (JsgbFrameCap.h, JsgbFrameCap.cpp). */
	UFUNCTION() void SetFrameRate(float Fps);
	std::atomic<float> AskedFrameRate{0.f};
	/** Applies a display change ({width?, height?, mode?, vsync?, maxFps?}) without saving Unreal's settings. Game thread. */
	static void ApplyDisplay(const TSharedPtr<class FJsonObject>& In);
	/** At launch: clears any frame cap left in Unreal's shared settings, then applies this game's saved display settings. */
	void RestoreDisplay();
	/** Unreal graphics (window.jsgb.graphics): the current state as JSON {lumen, available}, and a change ({lumen})
	 *  that OnGraphicsSet applies on the game thread. */
	UFUNCTION() FString GraphicsGet();
	UFUNCTION() void GraphicsSet(const FString& Json);
	/** Sets the JSON GraphicsGet returns. Any thread. */
	void SetGraphicsInfo(const FString& Json);
	/** Applies a graphics change on the game thread (AJsgbHost::SetFidelity). */
	TFunction<void(const TSharedPtr<class FJsonObject>&)> OnGraphicsSet;
	/** Web Workers on their own threads (JsgbWorkers.h). Create returns 0 when threaded workers are off. */
	UFUNCTION() int32 WorkerCreate(const FString& Source, const FString& Url, const FString& Name);
	UFUNCTION() void WorkerPost(int32 Id, FArrayBuffer Bytes);
	/** Every message and error from all workers since the last poll: [id, kind (0 message, 1 error), length, bytes] repeated, as int32s and bytes. */
	UFUNCTION() FArrayBufferValue WorkerPoll();
	UFUNCTION() void WorkerTerminate(int32 Id);
	/** Blob URLs shared with worker threads (FJsgbBlobs). */
	UFUNCTION() void BlobPut(const FString& Url, FArrayBuffer Bytes, const FString& Type);
	UFUNCTION() FArrayBufferValue BlobGet(const FString& Url);
	UFUNCTION() FString BlobType(const FString& Url);
	/** readRenderTargetPixelsAsync: ask for a capture target's pixels, then poll until they come (JsgbSceneMirror). */
	UFUNCTION() void CaptureRead(int32 TextureId);
	UFUNCTION() FArrayBufferValue CaptureTake(int32 TextureId);
	/** Files the person picks in the open panel or drops on the window, read by id (JsgbFiles.cpp, Runtime/src/fileApi.ts).
	 *  FilePickOpen returns a request (0: no panel here); FilePickTake is empty while the panel is up, then {"files": [...]} or
	 *  {"cancel": true}. PickedFolderList is a chosen folder's entries, DroppedFiles the latest drop's files (once). */
	UFUNCTION() int32 FilePickOpen(const FString& OptionsJson);
	UFUNCTION() FString FilePickTake(int32 Request);
	UFUNCTION() FArrayBufferValue PickedFileRead(int32 Id, double Offset, int32 Length);
	UFUNCTION() FString PickedFolderList(int32 Id);
	UFUNCTION() FString DroppedFiles();
	/** Exports (Runtime/src/media.ts): a picture of a scene frame drawn now (JsgbCapture.cpp), image files, the save
	 *  dialog, downloads and H.264 video (JsgbMedia.cpp, JsgbSavePanelMac.mm, JsgbVideoEncodeMac.mm). */
	UFUNCTION() FArrayBufferValue CaptureView(FArrayBuffer Floats, int32 Count, FArrayBuffer Instances, int32 InstanceFloats, int32 Width, int32 Height, bool bFloat);
	/** A page's full-screen passes into render targets, run when it reads one back (JsgbPassRunner.cpp): a scene they
	 *  start from into a slot, then the passes in order, returning the rectangle read as floats. */
	UFUNCTION() bool PassScene(FArrayBuffer Floats, int32 Count, FArrayBuffer Instances, int32 InstanceFloats, int32 Slot, int32 Width, int32 Height, int32 Format);
	UFUNCTION() FArrayBufferValue PassRun(const FString& Json);
	UFUNCTION() FArrayBufferValue EncodeImage(FArrayBuffer Rgba, int32 Width, int32 Height, const FString& Type, float Quality);
	UFUNCTION() int32 SavePick(const FString& Name, const FString& TypesJson);
	UFUNCTION() FString SaveTake(int32 Id);
	UFUNCTION() bool SaveWrite(int32 Id, FArrayBuffer Bytes, bool bAppend);
	UFUNCTION() FString Download(const FString& Name, FArrayBuffer Bytes);
	UFUNCTION() bool VideoSupported(const FString& Json);
	UFUNCTION() int32 VideoOpen(const FString& Json);
	UFUNCTION() bool VideoEncode(int32 Id, FArrayBuffer Rgba, int32 Width, int32 Height, double TimestampUs, double DurationUs, bool bKey);
	UFUNCTION() FArrayBufferValue VideoTake(int32 Id);
	UFUNCTION() bool VideoFlush(int32 Id);
	UFUNCTION() void VideoClose(int32 Id);
	UFUNCTION() void BlobRevoke(const FString& Url);
	/** What a browser takes from the system (JsgbSystem.h): window.alert, confirm and prompt as a native dialog the call
	 *  waits for ("1" and the typed text for OK, "0" for Cancel), the clipboard (types as JSON, text by web type, the
	 *  picture as PNG, copied files as entries, and a write of {type: text} with an optional PNG), the light or dark
	 *  look ("dark", "light", or empty) and the time zone's IANA name. */
	UFUNCTION() FString ShowDialog(const FString& Kind, const FString& Message, const FString& Value);
	UFUNCTION() FString ClipboardTypes();
	UFUNCTION() FString ClipboardText(const FString& Type);
	UFUNCTION() FArrayBufferValue ClipboardImage();
	UFUNCTION() FString ClipboardFiles();
	UFUNCTION() bool ClipboardWrite(const FString& TextsJson, FArrayBuffer Png);
	UFUNCTION() FString ColorScheme();
	UFUNCTION() FString TimeZoneName();
	/** V8's sampling profiler on the calling thread's isolate: "start", or "stop <file>" to write a .cpuprofile
	 *  (Chrome DevTools' Performance panel opens it). Called from the game's JavaScript, for example through /bridge/eval. */
	UFUNCTION() FString ProfileJs(const FString& Command);
	void StopWorkers();

	/** With the game's JavaScript on its own thread (-JsgbJsThread), calls that change Unreal state are
	 *  queued and run on the game thread by DrainGameCommands, in order; of several frame snapshots
	 *  waiting at once, only the newest is applied. Input and eval travel the other way through RunOnJs. */
	bool bJsThread = false;
	void RunOnGame(TFunction<void()>&& Fn, bool bFrame = false, std::source_location From = std::source_location::current());
	/** Runs the queued state changes; returns how many frame snapshots it applied (0 or 1). */
	int32 DrainGameCommands();
	void RunOnJs(TFunction<void()>&& Fn);
	/** Runs the queued input and eval calls on the JavaScript thread. */
	void DrainJsCommands();
	struct FGameCommand { TFunction<void()> Fn; bool bFrame = false; std::source_location From; };
	TQueue<FGameCommand, EQueueMode::Mpsc> GameCommands;
	TQueue<TFunction<void()>, EQueueMode::Mpsc> JsCommands;
	FCriticalSection LogLock;
	UFUNCTION() double NowMs() const;
	UFUNCTION() void Log(const FString& Level, const FString& Text);
	UFUNCTION() void RequestReload();
	UFUNCTION() FString LoadStore(const FString& Key);
	UFUNCTION() bool SaveStore(const FString& Key, const FString& Data);
	/** Deletes a stored entry's file (IndexedDB removes what it no longer needs instead of leaving empty files). */
	UFUNCTION() void RemoveStore(const FString& Key);
	UFUNCTION() void JsReady(const FString& Info);
	/** Bytes kept for the life of the Unreal process, so a hot reload can reuse earlier work (worker results). */
	UFUNCTION() FArrayBufferValue CacheGet(const FString& Key);
	UFUNCTION() void CachePut(const FString& Key, FArrayBuffer Bytes);
	/** Canvas text: glyph coverage for one run of text. Returns five floats (width, height, ascent,
	 *  descent, advance) followed by width*height alpha bytes; empty when the font cannot load. */
	UFUNCTION() FArrayBufferValue Text(const FString& FontPath, float SizePx, const FString& Run);

	// Scene sink (Runtime/src/sceneExport.ts describes the layout).
	UFUNCTION() void Geometry(int32 Id, FArrayBuffer Positions, FArrayBuffer Normals, FArrayBuffer UVs, FArrayBuffer Colors, int32 ColorSize, FArrayBuffer Indices, const FString& Groups);
	UFUNCTION() void ReleaseGeometry(int32 Id);
	/** A material or texture the game disposed of or dropped: its Unreal copy is freed. */
	UFUNCTION() void ReleaseMaterial(int32 Id);
	UFUNCTION() void ReleaseTexture(int32 Id);
	UFUNCTION() void Material(int32 Id, const FString& Json);
	/** window.jsgb.camera.rig (Runtime/src/cameraRig.ts): the camera the host moves with the keys (JsgbCameraRig.h). */
	UFUNCTION() FString CameraTake() { return CameraRig.Take(); }
	UFUNCTION() void CameraGive(int32 Version, const FString& Json);
	UFUNCTION() void CameraConfig(const FString& Json) { CameraRig.Configure(Json); }
	UFUNCTION() void CameraOff() { CameraRig.Reset(); }
	FJsgbCameraRig CameraRig;
	// JavaScript-thread staging: consumed by Frame and queued atomically with its camera matrix.
	FJsgbCameraRig::FState PendingCameraBase;
	int64 PendingCameraSeq = 0;
	bool bPendingCameraBase = false;
	/** Colour, map and uniforms of a material described before ({"color","map","uniforms"}), when nothing else changed. */
	UFUNCTION() void MaterialUniforms(int32 Id, const FString& Json);
	UFUNCTION() void Texture(int32 Id, const FString& Json, FArrayBuffer Bytes);
	UFUNCTION() void Frame(FArrayBuffer Floats, int32 Count, FArrayBuffer Instances, int32 InstanceFloats);
	UFUNCTION() void Events(const FString& Json);
	UFUNCTION() void Shader(const FString& Key, const FString& Json);

	// DOM UI and audio.
	UFUNCTION() void PublishUI(const FString& Html);
	UFUNCTION() void UICanvas(const FString& Id, int32 Width, int32 Height, FArrayBuffer Rgba);
	UFUNCTION() void AudioVoices(const FString& Json);
	UFUNCTION() void AudioPreload(const FString& Path);
	UFUNCTION() void AudioPcm(int32 Id, FArrayBuffer Samples, int32 SampleRate);

	TArray<FString> PublicRoots;
	/** The worker runtime script (jsgb/worker-runtime.js in the game build); empty turns threaded workers off. */
	FString WorkerRuntime;
	TMap<int32, TSharedPtr<class FJsgbWorker>> Workers;
	int32 NextWorker = 0;
	FString StoreDir;
	/** The game folder's jsgb-store: entries a package ships, read when StoreDir has none. */
	FString SeedStoreDir;
	FString LogPath;
	double StartSeconds = 0;
	/** When > 0, the game clock advances this many ms per host tick (deterministic captures). */
	UPROPERTY() double FixedStepMs = 0;
	double VirtualMs = 0;
	/** Time spent in the mirror (frames, materials, textures) since the host last read it. */
	double MirrorMs = 0;
	/** The material and texture parts of MirrorMs, and how many updates arrived, until the host reads and clears them. */
	double MaterialMs = 0, TextureMs = 0;
	int32 MaterialCalls = 0, TextureCalls = 0;
	bool bReloadRequested = false;
	bool bReady = false;
	int32 ErrorCount = 0;
	int32 Generation = 0;
	FString UIHtml;
	int64 UIVersion = 0;
	/** Pixels of the page's 2D canvases waiting for the overlay: id -> width, height, RGBA. */
	struct FUICanvas { int32 Width = 0, Height = 0; TArray<uint8> Rgba; };
	TMap<FString, FUICanvas> UICanvases;
	int64 SceneFrames = 0;
	/** Files the game has read so far (the loading screen shows it). */
	std::atomic<int32> FilesRead{0};
	FCriticalSection DisplayLock;
	FString DisplayModesJson, DisplayJson;
	FString GraphicsJson = TEXT("{\"lumen\":false,\"available\":false}");
	/** When the JavaScript thread made the newest scene frame the game thread applied (FPlatformTime seconds). */
	double LastFrameProducedAt = 0;
	UPROPERTY() TObjectPtr<UJsgbSceneMirror> Mirror;
	UPROPERTY() TObjectPtr<UJsgbAudio> Audio;
};
