// Off-screen WebKit (the engine the Tauri window uses on macOS): load a page,
// run JavaScript steps, print each result, and save a picture of the page
// after each step (the page only, never the screen). Chromium previews miss
// WebKit's own layout and form-control differences; check UI changes here.
//
//   swiftc -O scripts/webkit-check.swift -o /tmp/webkit-check
//   /tmp/webkit-check http://localhost:5177/ /tmp/shot 'document.getElementById("open-settings").click(); return "ok"'
//   WK_TAURI_ROOT=dist /tmp/webkit-check "tauri://localhost/index.html?backend=http://127.0.0.1:5177" /tmp/shot '...'
//
// The second form serves the built UI from tauri://localhost like the app does.
import AppKit
import WebKit

let args = CommandLine.arguments
let url = URL(string: args[1])!
let out = args[2]
let steps = Array(args.dropFirst(3))

final class Runner: NSObject, WKNavigationDelegate {
  let view: WKWebView
  var i = 0
  init(_ v: WKWebView) { view = v }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.next() }
  }
  func next() {
    if i >= steps.count { snap(); return }
    let js = steps[i]; i += 1
    if js.hasPrefix("key:") {
      let name = String(js.dropFirst(4))
      let keys: [String: (UInt16, String, NSEvent.ModifierFlags)] = ["Tab": (48, "\t", []), "ShiftTab": (48, "\t", [.shift]), "Escape": (53, "\u{1b}", []), "Space": (49, " ", [])]
      guard let (code, chars, flags) = keys[name] else { print("step \(i) error: unsupported key"); snapNamed("\(out)-\(i).png") { self.next() }; return }
      for type in [NSEvent.EventType.keyDown, .keyUp] {
        if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: view.window!.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
          if type == .keyDown { view.keyDown(with: event) } else { view.keyUp(with: event) }
        }
      }
      print("step \(i): native key \(name)")
      snapNamed("\(out)-\(i).png") { self.next() }; return
    }
    view.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
      switch r {
      case .success(let v): print("step \(self.i): \(String(describing: v ?? "nil"))")
      case .failure(let e): print("step \(self.i) error: \(e)")
      }
      self.snapNamed("\(out)-\(self.i).png") { self.next() }
    }
  }
  func snapNamed(_ path: String, _ done: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      self.view.takeSnapshot(with: nil) { img, _ in
        if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: path))
        }
        done()
      }
    }
  }
  func snap() { NSApp.terminate(nil) }
}

// Serves tauri://localhost/<path> from a folder, the way the Tauri shell serves the built UI.
final class Scheme: NSObject, WKURLSchemeHandler {
  let root: String
  init(_ r: String) { root = r }
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    var p = task.request.url!.path
    if p == "/" || p.isEmpty { p = "/index.html" }
    let file = URL(fileURLWithPath: root + p)
    let data = (try? Data(contentsOf: file)) ?? Data()
    let type = p.hasSuffix(".js") ? "text/javascript" : p.hasSuffix(".css") ? "text/css" : p.hasSuffix(".svg") ? "image/svg+xml" : "text/html"
    task.didReceive(URLResponse(url: task.request.url!, mimeType: type, expectedContentLength: data.count, textEncodingName: "utf-8"))
    task.didReceive(data)
    task.didFinish()
  }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
if let root = ProcessInfo.processInfo.environment["WK_TAURI_ROOT"] { config.setURLSchemeHandler(Scheme(root), forURLScheme: "tauri") }
let width = Double(ProcessInfo.processInfo.environment["WK_WIDTH"] ?? "1100") ?? 1100
let height = Double(ProcessInfo.processInfo.environment["WK_HEIGHT"] ?? "760") ?? 760
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = view
window.makeFirstResponder(view)
window.setFrameOrigin(NSPoint(x: -5000, y: -5000))
window.orderBack(nil)
let runner = Runner(view)
view.navigationDelegate = runner
view.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { NSApp.terminate(nil) }
app.run()
