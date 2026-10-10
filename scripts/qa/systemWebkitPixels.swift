import Cocoa
import WebKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3,
      let probeURL = URL(string: CommandLine.arguments[1]),
      probeURL.scheme == "http", probeURL.host == "127.0.0.1" else {
    fail("Usage: swift systemWebkitPixels.swift http://127.0.0.1:<port>/preview-probe-rotation.html <report.json>")
}
let reportURL = URL(fileURLWithPath: CommandLine.arguments[2])

final class PixelProbe: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? String,
              let data = payload.data(using: .utf8) else {
            fail("System WKWebView returned no pixel report")
        }
        do {
            guard var report = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                fail("System WKWebView returned an invalid pixel report")
            }
            report["engine"] = "system WKWebView"
            report["osVersion"] = ProcessInfo.processInfo.operatingSystemVersionString
            let output = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try output.write(to: reportURL, options: .atomic)
            print("System WKWebView pixels written to \(reportURL.path)")
            exit(0)
        } catch {
            fail("System WKWebView pixel report failed: \(error)")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("System WKWebView navigation failed: \(error)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("System WKWebView navigation failed: \(error)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let probe = PixelProbe()
let configuration = WKWebViewConfiguration()
configuration.mediaTypesRequiringUserActionForPlayback = []
configuration.userContentController.add(probe, name: "pixels")
configuration.userContentController.addUserScript(WKUserScript(source: """
    (function reportPixels() {
        if ("__rotation" in window) {
            window.webkit.messageHandlers.pixels.postMessage(JSON.stringify({
                userAgent: navigator.userAgent,
                shots: window.__rotation
            }));
        } else {
            setTimeout(reportPixels, 100);
        }
    })();
    """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 400), configuration: configuration)
webView.navigationDelegate = probe
let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = webView
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: probeURL))
let deadline = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { _ in
    fail("System WKWebView timed out without decoded pixel evidence")
}
app.run()