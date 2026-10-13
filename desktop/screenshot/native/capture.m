#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#include <errno.h>

// Legacy display-stream capture remains available at runtime on tested macOS 26.
// Resolve dynamically: current SDKs prohibit direct calls to the obsolete API.
// Do not silently fall back: other capture paths can omit visible windows.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (!CGPreflightScreenCaptureAccess()) {
      CGRequestScreenCaptureAccess();
      fprintf(stderr, "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许此应用，然后重新打开应用。\n");
      return 2;
    }
    CGDirectDisplayID display = CGMainDisplayID();
    if (argc == 2) {
      char *end = NULL; errno = 0;
      unsigned long value = strtoul(argv[1], &end, 10);
      if (errno || !*argv[1] || *end || value > UINT32_MAX || !CGDisplayIsActive((uint32_t)value)) {
        fprintf(stderr, "目标显示器不可用。\n"); return 3;
      }
      display = (uint32_t)value;
    } else if (argc != 1) { return 3; }
    void *handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY);
    typedef void (^FrameHandler)(int, uint64_t, IOSurfaceRef, void *);
    typedef void *(*CreateStream)(uint32_t, size_t, size_t, int32_t, CFDictionaryRef, dispatch_queue_t, FrameHandler);
    typedef int (*StartStream)(void *);
    CreateStream create = handle ? (CreateStream)dlsym(handle, "CGDisplayStreamCreateWithDispatchQueue") : NULL;
    StartStream start = handle ? (StartStream)dlsym(handle, "CGDisplayStreamStart") : NULL;
    if (!create || !start) { fprintf(stderr, "此 macOS 版本不再提供兼容截屏接口。\n"); return 4; }
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
    size_t width = mode ? CGDisplayModeGetPixelWidth(mode) : CGDisplayPixelsWide(display);
    size_t height = mode ? CGDisplayModeGetPixelHeight(mode) : CGDisplayPixelsHigh(display);
    if (mode) CFRelease(mode);
    void *stream = create(display, width, height, 0x42475241, NULL,
      dispatch_queue_create("com.hotpoor.screenshot", DISPATCH_QUEUE_SERIAL),
      ^(int status, uint64_t time, IOSurfaceRef surface, void *update) {
        if (status != 0 || !surface) return;
        @autoreleasepool {
          CIImage *frame = [CIImage imageWithIOSurface:surface];
          CGImageRef image = [[CIContext context] createCGImage:frame fromRect:frame.extent];
          if (!image) { fprintf(stderr, "无法读取屏幕图像。\n"); exit(5); }
          NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
          CGImageRelease(image);
          NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
          if (!png || fwrite(png.bytes, 1, png.length, stdout) != png.length || fflush(stdout)) {
            fprintf(stderr, "无法输出截图。\n"); exit(5);
          }
          exit(0);
        }
      });
    if (!stream || start(stream) != 0) { fprintf(stderr, "无法启动屏幕捕获，请检查屏幕录制权限。\n"); return 6; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      fprintf(stderr, "截图超时，请确认显示器已唤醒。\n"); exit(7);
    });
    [[NSRunLoop mainRunLoop] run];
  }
}
