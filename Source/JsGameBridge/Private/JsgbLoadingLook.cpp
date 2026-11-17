#include "JsgbLoadingLook.h"

#include "Brushes/SlateDynamicImageBrush.h"
#include "Dom/JsonObject.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

DEFINE_LOG_CATEGORY_STATIC(LogJsgbLoading, Log, All);

bool JsgbParseLoadingColor(const FString& Text, FColor& Out)
{
	FString Hex = Text.TrimStartAndEnd();
	if (!Hex.RemoveFromStart(TEXT("#"))) { return false; }
	if (Hex.Len() == 3) { Hex = FString::Printf(TEXT("%c%c%c%c%c%c"), Hex[0], Hex[0], Hex[1], Hex[1], Hex[2], Hex[2]); }
	if (Hex.Len() == 6) { Hex += TEXT("ff"); }
	if (Hex.Len() != 8) { return false; }
	uint8 Bytes[4];
	for (int32 I = 0; I < 4; ++I)
	{
		const TCHAR Hi = Hex[I * 2], Lo = Hex[I * 2 + 1];
		if (!FChar::IsHexDigit(Hi) || !FChar::IsHexDigit(Lo)) { return false; }
		Bytes[I] = static_cast<uint8>(FParse::HexDigit(Hi) * 16 + FParse::HexDigit(Lo));
	}
	Out = FColor(Bytes[0], Bytes[1], Bytes[2], Bytes[3]);
	return true;
}

namespace
{
	void ReadColor(const FJsonObject& Look, const TCHAR* Key, FLinearColor& Out)
	{
		FString Text;
		FColor Color;
		if (!Look.TryGetStringField(Key, Text)) { return; }
		// The config's colours are sRGB, as in CSS; Slate wants linear ones.
		if (JsgbParseLoadingColor(Text, Color)) { Out = FLinearColor(Color); }
		else { UE_LOG(LogJsgbLoading, Warning, TEXT("Loading screen: %s \"%s\" is not a colour"), Key, *Text); }
	}

	void ReadImage(const FJsonObject& Look, const TCHAR* Key, const FString& GameDir, FJsgbLoadingImage& Out)
	{
		const TSharedPtr<FJsonObject>* Image = nullptr;
		if (!Look.TryGetObjectField(Key, Image) || !Image || !(*Image).IsValid()) { return; }
		FString File, Tint;
		if (!(*Image)->TryGetStringField(TEXT("file"), File) || File.IsEmpty()) { return; }
		// Relative to the game's folder, like every path in publication.json.
		Out.File = FPaths::IsRelative(File) ? FPaths::ConvertRelativePathToFull(GameDir / File) : File;
		double Height = 0;
		Out.Height = (*Image)->TryGetNumberField(TEXT("height"), Height) && Height > 0 ? static_cast<float>(Height) : 24.f;
		FColor Color;
		if ((*Image)->TryGetStringField(TEXT("tint"), Tint) && JsgbParseLoadingColor(Tint, Color)) { Out.Tint = Color; }
	}

	/** The PNG as straight-alpha RGBA bytes. */
	bool DecodePng(const FString& File, TArray<uint8>& Rgba, int32& Width, int32& Height)
	{
		TArray<uint8> Bytes;
		if (!FFileHelper::LoadFileToArray(Bytes, *File)) { return false; }
		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		const TSharedPtr<IImageWrapper> Png = Module.CreateImageWrapper(EImageFormat::PNG);
		TArray64<uint8> Raw;
		if (!Png.IsValid() || !Png->SetCompressed(Bytes.GetData(), Bytes.Num()) || !Png->GetRaw(ERGBFormat::RGBA, 8, Raw)) { return false; }
		Width = static_cast<int32>(Png->GetWidth());
		Height = static_cast<int32>(Png->GetHeight());
		if (Width < 1 || Height < 1 || Raw.Num() != static_cast<int64>(Width) * Height * 4) { return false; }
		Rgba.Reset();
		Rgba.Append(Raw.GetData(), static_cast<int32>(Raw.Num()));
		return true;
	}

	/** One axis of an area resample: each output sample is the coverage-weighted mean of the input samples under it,
	 *  so a large mark shrinks without the aliasing of a GPU sampler minifying it several times. Lines counts the samples
	 *  across the other axis; bAlongRows picks the axis. Premultiplied RGBA floats. */
	void ResampleAxis(const TArray<float>& In, int32 InLen, int32 OutLen, int32 Lines, bool bAlongRows, TArray<float>& Out)
	{
		Out.SetNumZeroed(OutLen * Lines * 4);
		const double Step = static_cast<double>(InLen) / OutLen;
		for (int32 O = 0; O < OutLen; ++O)
		{
			const double A = O * Step, B = A + Step;
			const int32 Last = FMath::Min(InLen, FMath::CeilToInt32(B));
			for (int32 S = FMath::FloorToInt32(A); S < Last; ++S)
			{
				const float Weight = static_cast<float>((FMath::Min(B, S + 1.0) - FMath::Max(A, static_cast<double>(S))) / Step);
				for (int32 L = 0; L < Lines; ++L)
				{
					const int32 From = (bAlongRows ? L * InLen + S : S * Lines + L) * 4;
					const int32 To = (bAlongRows ? L * OutLen + O : O * Lines + L) * 4;
					for (int32 C = 0; C < 4; ++C) { Out[To + C] += In[From + C] * Weight; }
				}
			}
		}
	}

	/** The image at OutW x OutH as straight-alpha BGRA (what Slate's dynamic images take), tinted first if asked. */
	TArray<uint8> Prepare(const TArray<uint8>& Rgba, int32 W, int32 H, int32 OutW, int32 OutH, const TOptional<FColor>& Tint)
	{
		TArray<float> Pixels;
		Pixels.SetNumUninitialized(W * H * 4);
		for (int32 P = 0; P < W * H; ++P)
		{
			const uint8* Src = &Rgba[P * 4];
			const float Alpha = (Tint.IsSet() ? Src[3] * Tint->A / 255.f : Src[3]) / 255.f;
			const uint8 Rgb[3] = {Tint.IsSet() ? Tint->R : Src[0], Tint.IsSet() ? Tint->G : Src[1], Tint.IsSet() ? Tint->B : Src[2]};
			for (int32 C = 0; C < 3; ++C) { Pixels[P * 4 + C] = Rgb[C] * Alpha; }
			Pixels[P * 4 + 3] = Alpha;
		}
		TArray<float> Wide, Done;
		ResampleAxis(Pixels, W, OutW, H, true, Wide);
		ResampleAxis(Wide, H, OutH, OutW, false, Done);
		TArray<uint8> Bgra;
		Bgra.SetNumUninitialized(OutW * OutH * 4);
		for (int32 P = 0; P < OutW * OutH; ++P)
		{
			const float Alpha = FMath::Clamp(Done[P * 4 + 3], 0.f, 1.f);
			const auto Channel = [&](int32 C) { return static_cast<uint8>(FMath::Clamp(FMath::RoundToInt32(Alpha > 0.f ? Done[P * 4 + C] / Alpha : 0.f), 0, 255)); };
			Bgra[P * 4 + 0] = Channel(2);
			Bgra[P * 4 + 1] = Channel(1);
			Bgra[P * 4 + 2] = Channel(0);
			Bgra[P * 4 + 3] = static_cast<uint8>(FMath::RoundToInt32(Alpha * 255.f));
		}
		return Bgra;
	}

	void MakeBrush(FJsgbLoadingImage& Image, const TCHAR* Role, float PixelScale)
	{
		Image.Brush.Reset();
		TArray<uint8> Rgba;
		int32 W = 0, H = 0;
		if (Image.File.IsEmpty()) { return; }
		if (!DecodePng(Image.File, Rgba, W, H)) { UE_LOG(LogJsgbLoading, Warning, TEXT("Loading screen: could not read the PNG %s"), *Image.File); return; }
		// The texture has exactly the pixels the image covers on screen; the brush is sized in points.
		const int32 OutH = FMath::Clamp(FMath::RoundToInt32(Image.Height * PixelScale), 1, 4096);
		const int32 OutW = FMath::Clamp(FMath::RoundToInt32(static_cast<float>(W) * OutH / H), 1, 4096);
		static int32 Made = 0;
		const FName Name(*FString::Printf(TEXT("JsgbLoading_%s_%d"), Role, ++Made));
		Image.Brush = FSlateDynamicImageBrush::CreateWithImageData(Name, FVector2D(OutW, OutH), Prepare(Rgba, W, H, OutW, OutH, Image.Tint));
		if (Image.Brush.IsValid()) { Image.Brush->SetImageSize(FVector2D(OutW / PixelScale, OutH / PixelScale)); }
		UE_LOG(LogJsgbLoading, Display, TEXT("Loading screen %s: %s, %dx%d drawn at %dx%d pixels (%.2f per point)"), Role, *FPaths::GetCleanFilename(Image.File), W, H, OutW, OutH, PixelScale);
	}
}

FJsgbLoadingLook FJsgbLoadingLook::Load(const FString& GameDir, const FString& DefaultTitle)
{
	FJsgbLoadingLook Look;
	Look.Title = DefaultTitle.IsEmpty() ? FString(TEXT("Loading")) : DefaultTitle;
	FString Text;
	TSharedPtr<FJsonObject> Pub;
	const TSharedPtr<FJsonObject>* Found = nullptr;
	if (!FFileHelper::LoadFileToString(Text, *(GameDir / TEXT("publication.json"))) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Pub) || !Pub.IsValid()
		|| !Pub->TryGetObjectField(TEXT("loading"), Found) || !Found || !(*Found).IsValid())
	{
		return Look;
	}
	const FJsonObject& L = **Found;
	FString Title;
	if (L.TryGetStringField(TEXT("title"), Title) && !Title.IsEmpty()) { Look.Title = Title; }
	L.TryGetStringField(TEXT("byline"), Look.Byline);
	ReadColor(L, TEXT("background"), Look.Background);
	ReadColor(L, TEXT("titleColor"), Look.TitleColor);
	ReadColor(L, TEXT("bylineColor"), Look.BylineColor);
	ReadColor(L, TEXT("accent"), Look.Accent);
	ReadColor(L, TEXT("statusColor"), Look.StatusColor);
	ReadImage(L, TEXT("logo"), GameDir, Look.Logo);
	ReadImage(L, TEXT("bylineLogo"), GameDir, Look.BylineLogo);
	return Look;
}

void FJsgbLoadingLook::MakeBrushes(float PixelScale)
{
	const float Scale = FMath::Clamp(PixelScale, 0.25f, 8.f);
	MakeBrush(Logo, TEXT("logo"), Scale);
	MakeBrush(BylineLogo, TEXT("bylineLogo"), Scale);
}
