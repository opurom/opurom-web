/* Real WKWebView driver for the same emitted index.html. It loads the page
 * with loadHTMLString, evaluates the readback script after navigation, writes
 * one base64 result line to stdout, and exits. The Node wrapper bounds this
 * process and cleans its temporary profile; this program also bounds its own
 * run loop so a stalled WebKit callback cannot keep it alive indefinitely. */

import AppKit
import Darwin
import Foundation
import WebKit

private let resultPrefix = "OPR8_RESULT="

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("error: " + message + "\n").utf8))
    exit(1)
}

final class Driver: NSObject, WKNavigationDelegate {
    private let htmlPath: String
    private let scriptPath: String
    private let timeout: TimeInterval
    private let javaScript: String
    private var webView: WKWebView?
    private var finished = false

    init(htmlPath: String, scriptPath: String, timeout: TimeInterval) throws {
        self.htmlPath = htmlPath
        self.scriptPath = scriptPath
        self.timeout = timeout
        self.javaScript = try String(contentsOfFile: scriptPath, encoding: .utf8)
    }

    func start() throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 270), configuration: configuration)
        view.navigationDelegate = self
        self.webView = view

        let html = try String(contentsOfFile: htmlPath, encoding: .utf8)
        let directory = URL(fileURLWithPath: (htmlPath as NSString).deletingLastPathComponent, isDirectory: true)
        view.loadHTMLString(html, baseURL: directory)

        let deadline = Date().addingTimeInterval(timeout)
        while !finished && Date() < deadline {
            let next = Date().addingTimeInterval(0.05)
            RunLoop.current.run(until: next < deadline ? next : deadline)
        }
        if !finished {
            fail("WebKit evaluation timed out after \(Int(timeout * 1000)) ms")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(javaScript) { result, error in
            if let error = error {
                fail("WKWebView JavaScript evaluation failed: \(error.localizedDescription)")
            }
            guard let encoded = result as? String else {
                fail("WKWebView JavaScript evaluation did not return a string")
            }
            print("\(resultPrefix)\(encoded)")
            self.finished = true
            exit(0)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("WKWebView navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("WKWebView provisional navigation failed: \(error.localizedDescription)")
    }
}

_ = NSApplication.shared
_ = NSApplication.shared.setActivationPolicy(.accessory)

let arguments = CommandLine.arguments
guard arguments.count == 4, let timeoutMs = Double(arguments[3]), timeoutMs > 0 else {
    fail("usage: WebKitRunner <index.html> <readback.js> <timeout-ms>")
}
do {
    let driver = try Driver(
        htmlPath: arguments[1],
        scriptPath: arguments[2],
        timeout: timeoutMs / 1000.0
    )
    try driver.start()
} catch {
    fail("cannot start WKWebView driver: \(error.localizedDescription)")
}
