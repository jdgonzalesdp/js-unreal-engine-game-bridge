#pragma once

#include "CoreMinimal.h"
#include "JsgbLoadingLook.h"

class SWidget;
class SJsgbLayerKeeper;

/** What the game has shown so far, which decides when the loading screen goes. */
struct FJsgbLoadingProgress
{
	/** A page game: its own web build runs in the browser, and it has loaded. */
	bool bPage = false;
	bool bPageLoaded = false;
	/** The UI overlay exists, and it has applied the game's HTML. */
	bool bOverlay = false;
	bool bUiShown = false;
	/** The mirrored scene drew something. */
	bool bSceneDrawn = false;
	/** The game's JavaScript reported ready. */
	bool bReady = false;
	/** The bundled pipeline cache is still compiling. */
	bool bShadersPending = false;
};

/** The loading screen, from launch until the game shows something: the game's name or wordmark and byline
 *  (JsgbLoadingLook.h), a moving bar and a status line. It sits above the UI overlay, except on a Mac, where Slate
 *  drawn above the overlay's native web view never reaches the screen (JsgbMacOverlay.mm), so it sits under it. During
 *  engine startup the movie player draws it too, on its own thread, because nothing else draws until startup ends. */
class FJsgbLoadingScreen : public TSharedFromThis<FJsgbLoadingScreen>
{
public:
	/** Shows it over the game viewport; null without one. Status is the files and shaders line. Game thread. */
	static TSharedPtr<FJsgbLoadingScreen> Show(const FString& GameDir, const FString& Title, TFunction<FText()> Status);

	/** Call each tick; true once it has gone. */
	bool Update(const FJsgbLoadingProgress& Progress);

	double ShownSeconds() const { return FPlatformTime::Seconds() - Start; }

	~FJsgbLoadingScreen();

private:
	FJsgbLoadingLook Look;
	double Start = 0, ReadyAt = -1, FadeStart = -1;
	bool bStartupMovie = false;
	TSharedPtr<SJsgbLayerKeeper> Keeper;
	TSharedPtr<SWidget> Content;

	void ShowDuringStartup(float PixelScale);
	void EndStartupMovie();
};
