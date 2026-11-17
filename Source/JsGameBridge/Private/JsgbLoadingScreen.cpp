#include "JsgbLoadingScreen.h"

#include "Brushes/SlateDynamicImageBrush.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/UserInterfaceSettings.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "MoviePlayer.h"
#include "Rendering/SlateRenderer.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbLoadingScreen, Log, All);

namespace
{
	// A Mac draws the UI overlay as a native web view above the game view, and Slate drawn above that view goes to a
	// Metal view that only ever held stale frames: the loading screen flickered there at 60 Hz, alternating with black,
	// until JsgbMacOverlay.mm hid it. So on a Mac the loading screen is under the overlay, in the game view, and shows
	// through the overlay until the page draws over it. Elsewhere the overlay is a Slate texture and the loading screen
	// covers it, below the frame rate readout.
	constexpr int32 LoadingZOrder = PLATFORM_MAC ? 90 : 250;
	constexpr double ReadyGraceSeconds = 3.0, FadeSeconds = 0.25;
	// More Slate layers than the screen ever uses, kept after it goes (SJsgbLayerKeeper).
	constexpr int32 ReservedLayers = 64;
}

/** Draws its content at a fixed number of pixels per point, whatever scale its host applies, so the screen looks the
 *  same in the game viewport and in the movie player and its images map one texel to one pixel. Zero passes through. */
class SJsgbPixelScale : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SJsgbPixelScale) {}
		SLATE_ARGUMENT(float, PixelScale)
		SLATE_DEFAULT_SLOT(FArguments, Content)
	SLATE_END_ARGS()

	void Construct(const FArguments& Args)
	{
		PixelScale = Args._PixelScale;
		bHasRelativeLayoutScale = true;
		SetCanTick(false);
		ChildSlot[Args._Content.Widget];
	}
	virtual void OnArrangeChildren(const FGeometry& Geometry, FArrangedChildren& Out) const override
	{
		const TSharedRef<SWidget>& Child = ChildSlot.GetWidget();
		if (!Out.Accepts(Child->GetVisibility())) { return; }
		const float Scale = Relative(Geometry.Scale);
		Out.AddWidget(Geometry.MakeChild(Child, FVector2D::ZeroVector, Geometry.GetLocalSize() / Scale, Scale));
	}
	virtual float GetRelativeLayoutScale(int32 ChildIndex, float LayoutScaleMultiplier) const override { return Relative(LayoutScaleMultiplier); }

private:
	float PixelScale = 0.f;
	float Relative(float HostScale) const { return PixelScale > 0.f && HostScale > 0.f ? PixelScale / HostScale : 1.f; }
};

/** The loading screen's slot in the game viewport. It keeps the same number of Slate layers before and after the screen
 *  goes, so the overlay above it keeps its layer: on a Mac a new layer makes the engine rebuild the overlay's native
 *  layer, a second chance to flash. Its slot stays, drawing nothing, once the content is released. */
class SJsgbLayerKeeper : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SJsgbLayerKeeper) {}
		SLATE_DEFAULT_SLOT(FArguments, Content)
	SLATE_END_ARGS()

	void Construct(const FArguments& Args)
	{
		SetVisibility(EVisibility::HitTestInvisible);
		ChildSlot[Args._Content.Widget];
	}
	void Release() { ChildSlot[SNullWidget::NullWidget]; }
	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geometry, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 LayerId,
		const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		return FMath::Max(SCompoundWidget::OnPaint(Args, Geometry, Culling, Out, LayerId, Style, bParentEnabled), LayerId + ReservedLayers);
	}
};

namespace
{
	/** Pixels per point of a widget in the game viewport: the engine's UI scale for the viewport's size in pixels. */
	float ViewportPixelScale()
	{
		FVector2D Size = FVector2D::ZeroVector;
		if (GEngine && GEngine->GameViewport) { GEngine->GameViewport->GetViewportSize(Size); }
		if (Size.X < 1.0 || Size.Y < 1.0) { return 0.f; }
		return GetDefault<UUserInterfaceSettings>()->GetDPIScaleBasedOnSize(FIntPoint(FMath::RoundToInt32(Size.X), FMath::RoundToInt32(Size.Y)));
	}

	TSharedRef<SWidget> MakeImage(const TSharedPtr<FSlateDynamicImageBrush>& Brush)
	{
		// The widget holds the brush, so the texture lives as long as any copy of the screen does.
		return SNew(SImage).Image_Lambda([Brush]() -> const FSlateBrush* { return Brush.Get(); });
	}

	/** The screen: the name (a wordmark image, else the title), the byline and its mark, the moving bar and Status. */
	TSharedRef<SWidget> MakeContent(const FJsgbLoadingLook& Look, double Start, const TAttribute<FText>& Status, float PixelScale)
	{
		auto Phase = [Start]() { return static_cast<float>(FMath::Fmod((FPlatformTime::Seconds() - Start) * 0.6, 1.0)); };
		const bool bByline = !Look.Byline.IsEmpty() || Look.BylineLogo.Brush.IsValid();
		TSharedRef<SWidget> Name = SNullWidget::NullWidget;
		if (Look.Logo.Brush.IsValid()) { Name = MakeImage(Look.Logo.Brush); }
		else { Name = SNew(STextBlock).Text(FText::FromString(Look.Title)).Font(FCoreStyle::GetDefaultFontStyle("Bold", 34)).ColorAndOpacity(Look.TitleColor); }
		TSharedRef<SVerticalBox> Column = SNew(SVerticalBox);
		Column->AddSlot().AutoHeight().HAlign(HAlign_Center)[Name];
		if (bByline)
		{
			TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
			if (!Look.Byline.IsEmpty())
			{
				Row->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, Look.BylineLogo.Brush.IsValid() ? 7 : 0, 0)
				[
					SNew(STextBlock).Text(FText::FromString(Look.Byline)).Font(FCoreStyle::GetDefaultFontStyle("Regular", 13)).ColorAndOpacity(Look.BylineColor)
				];
			}
			if (Look.BylineLogo.Brush.IsValid()) { Row->AddSlot().AutoWidth().VAlign(VAlign_Center)[MakeImage(Look.BylineLogo.Brush)]; }
			Column->AddSlot().AutoHeight().HAlign(HAlign_Center).Padding(0, 6, 0, 0)[Row];
		}
		Column->AddSlot().AutoHeight().HAlign(HAlign_Center).Padding(0, bByline ? 22 : 18, 0, 0)
		[
			SNew(SBox).WidthOverride(420.f).HeightOverride(6.f)
			[
				SNew(SOverlay)
				+ SOverlay::Slot()[SNew(SBorder).BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush")).BorderBackgroundColor(FLinearColor(1.f, 1.f, 1.f, 0.12f))]
				+ SOverlay::Slot().HAlign(HAlign_Left)
				.Padding(TAttribute<FMargin>::CreateLambda([Phase]() { return FMargin(FMath::Max(0.f, Phase() * 520.f - 120.f), 0, 0, 0); }))
				[
					SNew(SBox).WidthOverride(TAttribute<FOptionalSize>::CreateLambda([Phase]() { const float X = Phase() * 520.f - 120.f; return FOptionalSize(FMath::Clamp(FMath::Min(120.f, 120.f + X), 0.f, FMath::Max(0.f, 420.f - X))); }))
					[
						SNew(SBorder).BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush")).BorderBackgroundColor(Look.Accent)
					]
				]
			]
		];
		Column->AddSlot().AutoHeight().HAlign(HAlign_Center).Padding(0, 14, 0, 0)
		[
			SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 14)).ColorAndOpacity(Look.StatusColor).Text(Status)
		];
		return SNew(SJsgbPixelScale).PixelScale(PixelScale)
		[
			SNew(SBorder).BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush")).BorderBackgroundColor(Look.Background)
			.HAlign(HAlign_Center).VAlign(VAlign_Center).Visibility(EVisibility::HitTestInvisible)
			[
				Column
			]
		];
	}

	/** Measures the screen's texts once on the game thread, so the fonts are loaded before another thread draws them. */
	void LoadFonts(const FJsgbLoadingLook& Look, float PixelScale)
	{
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const float Scale = PixelScale > 0.f ? PixelScale : 1.f;
		Measure->Measure(Look.Title, FCoreStyle::GetDefaultFontStyle("Bold", 34), Scale);
		Measure->Measure(Look.Byline + TEXT(" Starting"), FCoreStyle::GetDefaultFontStyle("Regular", 13), Scale);
		Measure->Measure(TEXT("Starting"), FCoreStyle::GetDefaultFontStyle("Regular", 14), Scale);
	}
}

TSharedPtr<FJsgbLoadingScreen> FJsgbLoadingScreen::Show(const FString& GameDir, const FString& Title, TFunction<FText()> Status)
{
	if (!GEngine || !GEngine->GameViewport) { return nullptr; }
	TSharedRef<FJsgbLoadingScreen> Screen = MakeShared<FJsgbLoadingScreen>();
	Screen->Start = FPlatformTime::Seconds();
	const float PixelScale = ViewportPixelScale();
	Screen->Look = FJsgbLoadingLook::Load(GameDir, Title);
	Screen->Look.MakeBrushes(PixelScale > 0.f ? PixelScale : 2.f);
	Screen->Content = MakeContent(Screen->Look, Screen->Start, TAttribute<FText>::CreateLambda(MoveTemp(Status)), PixelScale);
	Screen->Keeper = SNew(SJsgbLayerKeeper)[Screen->Content.ToSharedRef()];
	GEngine->GameViewport->AddViewportWidgetContent(Screen->Keeper.ToSharedRef(), LoadingZOrder);
	Screen->ShowDuringStartup(PixelScale);
	return Screen;
}

// Everything the host does at launch (the game's JavaScript, the overlay) runs inside the engine's startup, before its
// first frame, so the viewport's copy is not drawn until startup is over: the window stayed black for seconds and the
// screen then showed for one frame. The engine's movie player draws a second copy on its own thread meanwhile, and the
// engine ends it when startup finishes (FEngineLoop::Init). -JsgbNoStartupLoadingScreen or the engine's
// -NoLoadingScreen leaves startup undrawn, as before.
void FJsgbLoadingScreen::ShowDuringStartup(float PixelScale)
{
	if (GIsRunning || FParse::Param(FCommandLine::Get(), TEXT("JsgbNoStartupLoadingScreen")) || !IsMoviePlayerEnabled()) { return; }
	IGameMoviePlayer* Player = GetMoviePlayer();
	if (!Player || !Player->IsInitialized() || Player->IsMovieCurrentlyPlaying() || !FSlateApplication::IsInitialized()) { return; }
	LoadFonts(Look, PixelScale);
	FLoadingScreenAttributes Attributes;
	// The game thread is busy until startup ends, so this copy's status line stays as it starts.
	Attributes.WidgetLoadingScreen = MakeContent(Look, Start, FText::FromString(TEXT("Starting")), PixelScale);
	Attributes.bAutoCompleteWhenLoadingCompletes = true;
	Attributes.bMoviesAreSkippable = false;
	Player->SetupLoadingScreen(Attributes);
	bStartupMovie = Player->PlayMovie();
	UE_LOG(LogJsgbLoadingScreen, Display, TEXT("Loading screen: %s during engine startup"), bStartupMovie ? TEXT("drawn by the movie player") : TEXT("the movie player did not start; not drawn"));
}

void FJsgbLoadingScreen::EndStartupMovie()
{
	if (!bStartupMovie) { return; }
	bStartupMovie = false;
	// The engine ends it as startup finishes; this covers a host whose startup ended some other way.
	IGameMoviePlayer* Player = GetMoviePlayer();
	if (Player && Player->IsMovieCurrentlyPlaying()) { Player->WaitForMovieToFinish(); }
}

bool FJsgbLoadingScreen::Update(const FJsgbLoadingProgress& Progress)
{
	const double Now = FPlatformTime::Seconds();
	if (GIsRunning) { EndStartupMovie(); }
	if (Progress.bReady && ReadyAt < 0) { ReadyAt = Now; }
	if (FadeStart < 0)
	{
		// It goes once the game shows something itself: the loaded page (a page game), its HTML in the overlay, or a drawn
		// scene. A game that is ready but shows neither goes at once without an overlay, and after a short wait with one, so
		// the page's first paint lands on the loading screen rather than on an empty window.
		const bool bShown = Progress.bPage ? Progress.bPageLoaded
			: Progress.bUiShown || Progress.bSceneDrawn || (ReadyAt >= 0 && (!Progress.bOverlay || Now - ReadyAt > ReadyGraceSeconds));
		// It stays until the pipeline cache is compiled too; two minutes at most, so a game that never reports anything
		// isn't hidden behind it.
		if ((!bShown || Progress.bShadersPending) && Now - Start < 120.0) { return false; }
		FadeStart = Now;
	}
	const float Opacity = 1.f - static_cast<float>((Now - FadeStart) / FadeSeconds);
	if (Opacity > 0.f && Content.IsValid()) { Content->SetRenderOpacity(Opacity); return false; }
	if (Keeper.IsValid()) { Keeper->Release(); }
	Content.Reset();
	return true;
}

FJsgbLoadingScreen::~FJsgbLoadingScreen()
{
	EndStartupMovie();
	if (Keeper.IsValid()) { Keeper->Release(); }
}
