#pragma once

// The frame cap (t.MaxFPS) of a mirrored scene, and the page's request to lower it (window.jsgb.setFrameRate,
// Runtime/src/frameRate.ts). AJsgbHost::Tick asks Want once a frame and sets t.MaxFPS to the answer.
//
// Three caps meet here. The scene's default: -JsgbSceneFps=<n>, else "sceneFps" in the game's config
// (publication.json). A cap the player saved in the game's display settings, unlimited included, which wins over the
// default. And the page's request, which only ever lowers the other two: a film's camera view can ask for its 24
// frames a second, but a request for 120 in a game held to 60 still gets 60.
//
// The rule is plain C++ with no engine headers, so it can be checked on its own.
struct FJsgbFrameCap
{
	/** The game config's "sceneFps" (publication.json): the default cap when the command line names none; 0 for none. */
	float Published = 0.f;

	/** The lower of two caps, where 0 or less means no cap. */
	static float Lower(float A, float B)
	{
		if (A <= 0.f) { return B > 0.f ? B : 0.f; }
		if (B <= 0.f) { return A; }
		return A < B ? A : B;
	}

	/** The t.MaxFPS the host wants now, or a negative number to leave t.MaxFPS as it is.
	 *  Current: t.MaxFPS now. Scene: the default cap, 0 for none. Saved: the player's saved cap (0 for unlimited), or
	 *  negative when the player saved none. Asked: the page's request, 0 for none. */
	float Want(float Current, float Scene, float Saved, float Asked)
	{
		// What t.MaxFPS was before the page asked, to go back to when nothing else names a cap.
		if (Asked > 0.f && !bAsked) { bAsked = true; Before = Current; }
		const float Base = Saved >= 0.f ? Saved : Scene > 0.f ? Scene : Before;
		if (Asked > 0.f) { return Lower(Base, Asked); }
		// The request was dropped: back to the cap without it, once.
		if (bAsked) { bAsked = false; return Base; }
		// No request: the scene's default, unless the player saved a cap (which is already in force).
		return Saved < 0.f && Scene > 0.f ? Scene : -1.f;
	}

	/** A request was in force at the last Want, so the next Want is still needed: it undoes a dropped request. */
	bool IsAsked() const { return bAsked; }

private:
	float Before = 0.f;
	bool bAsked = false;
};

/** The frame cap of this Unreal process, which runs one game (JsgbFrameCap.cpp). It outlives the bridge, which a hot
 *  reload replaces, so a request in force when the page restarts is still undone. Game thread. */
FJsgbFrameCap& JsgbSceneFrameCap();
