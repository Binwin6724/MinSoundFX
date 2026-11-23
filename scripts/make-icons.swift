// Renders the MinSoundFX app icon and tray icons with AppKit.
//   swift scripts/make-icons.swift build
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build"
try? FileManager.default.createDirectory(atPath: "\(out)/tray", withIntermediateDirectories: true)

func save(_ img: NSImage, _ path: String, _ px: Int) {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: px, height: px)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

// Waveform bars used by both icons (heights as fraction of the canvas).
let bars: [CGFloat] = [0.22, 0.42, 0.66, 0.84, 0.58, 0.74, 0.46, 0.28]

func appIcon(_ s: CGFloat) -> NSImage {
  NSImage(size: NSSize(width: s, height: s), flipped: false) { _ in
    let inset = s * 0.1
    let rect = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = NSBezierPath(roundedRect: rect, xRadius: s * 0.2, yRadius: s * 0.2)
    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = s * 0.03
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.set()
    NSGradient(colors: [NSColor(red: 0.07, green: 0.08, blue: 0.13, alpha: 1), NSColor(red: 0.12, green: 0.10, blue: 0.22, alpha: 1)])!
      .draw(in: path, angle: -60)
    NSGraphicsContext.current?.restoreGraphicsState()
    // Soft glow
    let glow = NSGradient(colors: [NSColor(red: 0.49, green: 0.36, blue: 1, alpha: 0.45), NSColor.clear])!
    path.addClip()
    glow.draw(fromCenter: NSPoint(x: s * 0.62, y: s * 0.62), radius: 0, toCenter: NSPoint(x: s * 0.62, y: s * 0.62), radius: s * 0.55, options: [])
    // Bars
    let grad = NSGradient(colors: [NSColor(red: 0.49, green: 0.36, blue: 1, alpha: 1), NSColor(red: 0.13, green: 0.83, blue: 0.93, alpha: 1)])!
    let n = CGFloat(bars.count)
    let area = rect.insetBy(dx: s * 0.14, dy: s * 0.18)
    let bw = area.width / (n * 1.7)
    for (i, h) in bars.enumerated() {
      let x = area.minX + CGFloat(i) * (area.width - bw) / (n - 1)
      let bh = area.height * h
      let r = NSRect(x: x, y: area.midY - bh / 2, width: bw, height: bh)
      grad.draw(in: NSBezierPath(roundedRect: r, xRadius: bw / 2, yRadius: bw / 2), angle: 0)
    }
    return true
  }
}

func trayIcon(_ s: CGFloat, color: NSColor) -> NSImage {
  NSImage(size: NSSize(width: s, height: s), flipped: false) { _ in
    color.setFill()
    let n = CGFloat(5)
    let hs: [CGFloat] = [0.35, 0.7, 1.0, 0.6, 0.35]
    let bw = s / (n * 1.8)
    let gap = (s - bw * n) / (n + 1)
    for (i, h) in hs.enumerated() {
      let bh = s * 0.82 * h
      let x = gap + CGFloat(i) * (bw + gap)
      NSBezierPath(roundedRect: NSRect(x: x, y: (s - bh) / 2, width: bw, height: bh), xRadius: bw / 2, yRadius: bw / 2).fill()
    }
    return true
  }
}

save(appIcon(1024), "\(out)/icon.png", 1024)
save(trayIcon(18, color: .black), "\(out)/tray/trayTemplate.png", 18)
save(trayIcon(36, color: .black), "\(out)/tray/trayTemplate@2x.png", 36)
save(trayIcon(32, color: .white), "\(out)/tray/tray.png", 32)
print("✓ icons written to \(out)")
