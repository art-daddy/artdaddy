#import <AppKit/AppKit.h>
#include <stdbool.h>

typedef bool (*ADRequestWindowClose)(void);

@interface ADQuitDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) id<NSApplicationDelegate> original;
@property(nonatomic, assign) ADRequestWindowClose requestClose;
@end

@implementation ADQuitDelegate
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
  if ([self.original respondsToSelector:selector]) {
    return self.original;
  }
  return [super forwardingTargetForSelector:selector];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  if ([self.original respondsToSelector:@selector(applicationShouldTerminate:)]) {
    NSApplicationTerminateReply reply = [self.original applicationShouldTerminate:sender];
    if (reply != NSTerminateNow) {
      return reply;
    }
  }
  return self.requestClose() ? NSTerminateCancel : NSTerminateNow;
}
@end

static ADQuitDelegate *quitDelegate;

bool artdaddy_install_quit_delegate(ADRequestWindowClose requestClose) {
  if (![NSThread isMainThread] || requestClose == NULL || quitDelegate != nil) {
    return false;
  }
  NSApplication *app = NSApplication.sharedApplication;
  id<NSApplicationDelegate> original = app.delegate;
  if (original == nil) {
    return false;
  }
  quitDelegate = [ADQuitDelegate new];
  quitDelegate.original = original;
  quitDelegate.requestClose = requestClose;
  app.delegate = quitDelegate;
  return app.delegate == quitDelegate;
}
