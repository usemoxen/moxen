import Foundation
import CoreGraphics

let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid &&
    ($0[kCGWindowName as String] as? String) == "Moxen Agent" &&
    ($0[kCGWindowLayer as String] as? Int) == 0
}), let id = window[kCGWindowNumber as String] as? Int else {
    fputs("No desktop window for pid \(pid)\n", stderr)
    exit(1)
}
print(id)
