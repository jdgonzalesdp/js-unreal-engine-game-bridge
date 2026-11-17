// H.264 encoding with VideoToolbox, behind the page's VideoEncoder (Runtime/src/webcodecs.ts). Chunks come out in AVC
// form (length-prefixed NAL units) with the avcC record as the decoder description, as Chrome's encoder gives them on
// a Mac, so the page's MP4 muxer takes them unchanged. No frame reordering: chunks come out in presentation order.
#include "JsgbMedia.h"

#if PLATFORM_MAC
#include "Mac/MacSystemIncludes.h"
#include "Misc/ScopeLock.h"
#include "Templates/SharedPointer.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>

namespace
{
	struct FVideoSession
	{
		VTCompressionSessionRef Session = nullptr;
		int32 Width = 0, Height = 0;
		FCriticalSection Lock;
		/** Finished chunks, as webcodecs.ts reads them: key int32, size int32, timestamp and duration (float64 µs), bytes padded to 8. */
		TArray<uint8> Chunks;
		/** The avcC record, from the first key frame. */
		TArray<uint8> Description;
		bool bFailed = false;
		~FVideoSession() { if (Session) { VTCompressionSessionInvalidate(Session); CFRelease(Session); } }
	};
	using FSessionPtr = TSharedPtr<FVideoSession, ESPMode::ThreadSafe>;
	FCriticalSection SessionsLock;
	TMap<int32, FSessionPtr> Sessions;
	int32 NextSession = 0;

	FSessionPtr Find(int32 Id) { FScopeLock Lock(&SessionsLock); return Sessions.FindRef(Id); }
	double Micros(CMTime T) { return CMTIME_IS_VALID(T) && T.timescale > 0 ? FMath::RoundToDouble(static_cast<double>(T.value) * 1e6 / T.timescale) : 0.0; }

	void OnEncoded(void* Ref, void*, OSStatus Status, VTEncodeInfoFlags Flags, CMSampleBufferRef Sample)
	{
		FVideoSession* S = static_cast<FVideoSession*>(Ref);
		FScopeLock Lock(&S->Lock);
		if (Status != noErr) { S->bFailed = true; return; }
		if (!Sample || (Flags & kVTEncodeInfo_FrameDropped)) { return; }
		bool bKey = true;
		CFArrayRef Attachments = CMSampleBufferGetSampleAttachmentsArray(Sample, false);
		if (Attachments && CFArrayGetCount(Attachments) > 0)
		{
			CFDictionaryRef A = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(Attachments, 0));
			CFBooleanRef NotSync = A ? static_cast<CFBooleanRef>(CFDictionaryGetValue(A, kCMSampleAttachmentKey_NotSync)) : nullptr;
			bKey = !(NotSync && CFBooleanGetValue(NotSync));
		}
		if (bKey && S->Description.Num() == 0)
		{
			CMFormatDescriptionRef Format = CMSampleBufferGetFormatDescription(Sample);
			CFDictionaryRef Atoms = Format ? static_cast<CFDictionaryRef>(CMFormatDescriptionGetExtension(Format, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms)) : nullptr;
			CFDataRef AvcC = Atoms ? static_cast<CFDataRef>(CFDictionaryGetValue(Atoms, CFSTR("avcC"))) : nullptr;
			if (AvcC) { S->Description.Append(CFDataGetBytePtr(AvcC), static_cast<int32>(CFDataGetLength(AvcC))); }
		}
		CMBlockBufferRef Block = CMSampleBufferGetDataBuffer(Sample);
		const int32 Size = Block ? static_cast<int32>(CMBlockBufferGetDataLength(Block)) : 0;
		const int32 Key = bKey ? 1 : 0;
		const double Ts = Micros(CMSampleBufferGetPresentationTimeStamp(Sample)), Du = Micros(CMSampleBufferGetDuration(Sample));
		const int32 At = S->Chunks.Num();
		S->Chunks.AddZeroed(24 + ((Size + 7) & ~7));
		uint8* P = S->Chunks.GetData() + At;
		FMemory::Memcpy(P, &Key, 4); FMemory::Memcpy(P + 4, &Size, 4); FMemory::Memcpy(P + 8, &Ts, 8); FMemory::Memcpy(P + 16, &Du, 8);
		if (Size > 0 && CMBlockBufferCopyDataBytes(Block, 0, Size, P + 24) != kCMBlockBufferNoErr) { S->bFailed = true; }
	}

	FSessionPtr Create(int32 Width, int32 Height, double Bitrate, double Fps)
	{
		if (Width < 16 || Height < 16 || Width > 8192 || Height > 8192) { return nullptr; }
		FSessionPtr S = MakeShared<FVideoSession, ESPMode::ThreadSafe>();
		S->Width = Width; S->Height = Height;
		@autoreleasepool
		{
			NSDictionary* Source = @{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferWidthKey: @(Width),
				(id)kCVPixelBufferHeightKey: @(Height), (id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
			const OSStatus Err = VTCompressionSessionCreate(kCFAllocatorDefault, Width, Height, kCMVideoCodecType_H264, nullptr, (__bridge CFDictionaryRef)Source,
				kCFAllocatorDefault, OnEncoded, S.Get(), &S->Session);
			if (Err != noErr || !S->Session) { S->Session = nullptr; return nullptr; }
			VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_RealTime, kCFBooleanFalse);
			VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
			VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
			if (Bitrate > 0) { VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef)@(static_cast<int64>(Bitrate))); }
			if (Fps > 0)
			{
				VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFNumberRef)@(Fps));
				VTSessionSetProperty(S->Session, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFNumberRef)@(FMath::Max(1, FMath::RoundToInt(Fps))));
			}
			VTCompressionSessionPrepareToEncodeFrames(S->Session);
		}
		return S;
	}
}

bool JsgbVideoSupported(int32 Width, int32 Height) { return Create(Width, Height, 0, 0).IsValid(); }

int32 JsgbVideoOpen(int32 Width, int32 Height, double Bitrate, double Fps)
{
	FSessionPtr S = Create(Width, Height, Bitrate, Fps);
	if (!S) { return 0; }
	FScopeLock Lock(&SessionsLock);
	const int32 Id = ++NextSession;
	Sessions.Add(Id, S);
	return Id;
}

bool JsgbVideoEncode(int32 Id, const uint8* Rgba, int32 Width, int32 Height, double TimestampUs, double DurationUs, bool bKey)
{
	FSessionPtr S = Find(Id);
	if (!S || !S->Session) { return false; }
	{ FScopeLock Lock(&S->Lock); if (S->bFailed) { return false; } }
	@autoreleasepool
	{
		CVPixelBufferPoolRef Pool = VTCompressionSessionGetPixelBufferPool(S->Session);
		CVPixelBufferRef Buffer = nullptr;
		if (!Pool || CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, Pool, &Buffer) != kCVReturnSuccess || !Buffer) { return false; }
		// RGBA rows from the top into the session's BGRA buffer; a smaller frame is padded with black.
		CVPixelBufferLockBaseAddress(Buffer, 0);
		uint8* Base = static_cast<uint8*>(CVPixelBufferGetBaseAddress(Buffer));
		const size_t Stride = CVPixelBufferGetBytesPerRow(Buffer);
		const int32 W = FMath::Min(Width, S->Width), H = FMath::Min(Height, S->Height);
		for (int32 Y = 0; Y < S->Height; ++Y)
		{
			uint8* Row = Base + Y * Stride;
			FMemory::Memzero(Row, S->Width * 4);
			if (Y >= H) { continue; }
			const uint8* Src = Rgba + static_cast<size_t>(Y) * Width * 4;
			for (int32 X = 0; X < W; ++X, Src += 4, Row += 4) { Row[0] = Src[2]; Row[1] = Src[1]; Row[2] = Src[0]; Row[3] = 255; }
		}
		CVPixelBufferUnlockBaseAddress(Buffer, 0);
		NSDictionary* Options = bKey ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
		const CMTime Pts = CMTimeMake(static_cast<int64>(FMath::RoundToDouble(TimestampUs)), 1000000);
		const CMTime Dur = DurationUs > 0 ? CMTimeMake(static_cast<int64>(FMath::RoundToDouble(DurationUs)), 1000000) : kCMTimeInvalid;
		const OSStatus Err = VTCompressionSessionEncodeFrame(S->Session, Buffer, Pts, Dur, (__bridge CFDictionaryRef)Options, nullptr, nullptr);
		CVPixelBufferRelease(Buffer);
		return Err == noErr;
	}
}

void JsgbVideoTake(int32 Id, TArray<uint8>& Out)
{
	FSessionPtr S = Find(Id);
	if (!S) { return; }
	FScopeLock Lock(&S->Lock);
	const int32 DescSize = S->Description.Num(), Zero = 0;
	Out.SetNumUninitialized(8);
	FMemory::Memcpy(Out.GetData(), &DescSize, 4); FMemory::Memcpy(Out.GetData() + 4, &Zero, 4);
	Out.Append(S->Description);
	while (Out.Num() % 8) { Out.Add(0); }
	Out.Append(S->Chunks);
	S->Chunks.Reset();
}

bool JsgbVideoFlush(int32 Id)
{
	FSessionPtr S = Find(Id);
	if (!S || !S->Session) { return false; }
	const OSStatus Err = VTCompressionSessionCompleteFrames(S->Session, kCMTimeInvalid);
	FScopeLock Lock(&S->Lock);
	return Err == noErr && !S->bFailed;
}

void JsgbVideoClose(int32 Id)
{
	FSessionPtr S;
	{ FScopeLock Lock(&SessionsLock); Sessions.RemoveAndCopyValue(Id, S); }
	// The session is torn down (and its last callbacks finish) when S goes out of scope.
}
#endif
