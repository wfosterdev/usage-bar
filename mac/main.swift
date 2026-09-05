import AppKit
import Foundation

// MARK: - Wire format (mirrors GET /api/menubar)

struct Projection: Decodable {
    let percentPerHour: Double?
    let exhaustsAt: String?
    let minutesToExhaust: Double?
    let beatsReset: Bool?
}

/// A colour resolved for both system appearances. The server cannot know which
/// one this Mac is in, so it sends both and we pick.
struct ModeColor: Decodable {
    let light: String
    let dark: String

    func current() -> NSColor? {
        let name = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        return NSColor(hex: name == .darkAqua ? dark : light)
    }
}

struct LimitView: Decodable {
    let label: String
    let percent: Double?
    let resetsAt: String?
    let severity: String?
    let projection: Projection?
    /// Pre-rendered by the server so the glyph style is configurable without a
    /// rebuild. Optional so an older backend still decodes.
    let bar: String?
    let color: ModeColor?
}

struct Glance: Decodable {
    let known: Bool          // false until the first usage fetch lands
    let display: Double      // the number to paint
    let used: Double
    let remaining: Double
    let metric: String       // "remaining" | "used"
    let scope: String        // "session" | "worst"
    let label: String
    let suffix: String       // "left" | "used"
    let severity: String
}

struct ActiveSession: Decodable {
    let sessionId: String
    let title: String?
    let project: String?
    let branch: String?
    let model: String?
    let cost: Double
    let tokens: Double
    let contextPct: Double
    let subagents: Int
    // Optional so a newer app still decodes an older server's payload.
    let subagentsActive: Int?
    let busy: Bool
    let tool: String?
    let idleMs: Double?
}

/// A background and the ink the server measured as readable on it. A nil
/// background means "no plate": paint straight onto the menu bar, where only
/// NSColor.labelColor is guaranteed to be legible.
struct Chip: Decodable {
    let background: String?
    let text: String?
}

struct MenubarColors: Decodable {
    let scheme: String
    let fill: String          // "none" | "soft" | "solid"
    let severity: Bool
    let normal: Chip
    let warning: Chip
    let critical: Chip
    let accent: String?
}

/// Colours for the dropdown. Separate from MenubarColors because the two sit on
/// different backgrounds: the bar is on the wallpaper, the menu is on a system
/// material that actually follows the appearance and can be relied on.
struct MenuColors: Decodable {
    let material: String
    let ink: String
    let inkDim: String
    let accent: String
    let line: String
    let headerBackground: String?
    let headerText: String?
}

struct ThemeInfo: Decodable {
    let id: String
    let mode: String          // dashboard preference; the menu bar ignores it
    let style: String         // "plain" | "soft" | "solid"
    let light: MenubarColors
    let dark: MenubarColors
    let menuLight: MenuColors
    let menuDark: MenuColors
}


struct Totals: Decodable {
    let activeCost: Double
    let activeCostPerMin: Double
    let activeTokens: Double
}

struct MenubarState: Decodable {
    let ok: Bool
    let message: String?
    let glance: Glance
    let session: LimitView?
    let weekly: [LimitView]
    let plan: String?
    let ready: Bool?
    /// True when the numbers are real but the last fetch failed — usually a
    /// 429. Kept distinct from `ok` so a backoff does not present as an outage.
    let stale: Bool?
    let staleMessage: String?
    let retryAt: String?
    let theme: ThemeInfo?
    let activeSessions: [ActiveSession]
    let totals: Totals
}

// MARK: - Identity

/// Who built this and which build it is. The version comes from the bundle, which
/// build.sh fills in from package.json, so there is exactly one place to bump it.
enum AppInfo {
    static let homepage = "https://wfoster.dev"
    /// The link without its scheme — a menu item reads better without "https://".
    static let host = "wfoster.dev"
    static let author = "William Foster"

    static var version: String {
        // Missing means the plist is not being read, which is worth seeing rather
        // than papering over: it is the failure that once left the menu bar empty.
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
    }
}

// MARK: - Formatting

enum Fmt {
    static func money(_ v: Double) -> String {
        v >= 100 ? String(format: "$%.0f", v) : String(format: "$%.2f", v)
    }

    static func tokens(_ v: Double) -> String {
        if v >= 1_000_000 { return String(format: "%.1fM", v / 1_000_000) }
        if v >= 1_000 { return String(format: "%.0fK", v / 1_000) }
        return String(format: "%.0f", v)
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(max(0, seconds))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 48 { return "\(h)h \(m % 60)m" }
        return "\(h / 24)d"
    }

    /// Seconds from now until an ISO-8601 timestamp, or nil if unparseable.
    static func secondsUntil(_ iso: String?) -> Double? {
        guard let iso = iso else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        let date = withFraction.date(from: iso) ?? plain.date(from: iso)
        guard let d = date else { return nil }
        return d.timeIntervalSinceNow
    }

    static func bar(_ percent: Double, width: Int = 14) -> String {
        let p = min(100, max(0, percent))
        let filled = Int((p / 100.0 * Double(width)).rounded())
        return String(repeating: "\u{2588}", count: filled)
             + String(repeating: "\u{2591}", count: max(0, width - filled))
    }
}

extension NSColor {
    /// Parses "#rrggbb" (or "#rgb"). Returns nil for anything else, so callers
    /// fall back to a system colour rather than painting something wrong.
    convenience init?(hex: String?) {
        guard var h = hex?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#") else { return nil }
        h.removeFirst()
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((v >> 16) & 0xff) / 255.0,
                  green: CGFloat((v >> 8) & 0xff) / 255.0,
                  blue: CGFloat(v & 0xff) / 255.0,
                  alpha: 1.0)
    }
}

enum Palette {
    /// Which of the server's two palettes applies.
    ///
    /// Always the SYSTEM appearance, never the dashboard's light/dark setting.
    /// The two are different surfaces: choosing a dark dashboard on a machine
    /// running in light mode used to hand the menu bar its dark-palette colours,
    /// which are built for a dark background and vanish on a light one.
    static func current(_ theme: ThemeInfo?) -> MenubarColors? {
        guard let theme = theme else { return nil }
        let name = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        return name == .darkAqua ? theme.dark : theme.light
    }

    /// nil means "use the system label colour", which is what actually tracks
    /// the menu bar's own tint — including when a light wallpaper forces a light
    /// menu bar while the rest of the system is dark.
    static func color(_ hex: String?) -> NSColor {
        NSColor(hex: hex) ?? .labelColor
    }

    /// The dropdown's colours, resolved for the system appearance.
    static func menu(_ theme: ThemeInfo?) -> MenuColors? {
        guard let theme = theme else { return nil }
        let name = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        return name == .darkAqua ? theme.menuDark : theme.menuLight
    }

    /// The chip for a severity, or nil when the app is painting plain text.
    static func chip(_ colors: MenubarColors?, severity: String) -> Chip? {
        guard let c = colors else { return nil }
        switch severity {
        case "critical": return c.critical
        case "warning": return c.warning
        default: return c.normal
        }
    }
}

/// Draws the menu bar label as an opaque rounded plate.
///
/// This exists because the menu bar's background is the wallpaper: translucent,
/// arbitrary, and repainted by macOS whenever the desktop changes. No fixed text
/// colour survives that. Painting our own plate makes the only contrast that
/// matters one we control — and the server has already measured it.
enum Chipboard {
    static func image(text: String, background: NSColor, ink: NSColor) -> NSImage {
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
        let measured = (text as NSString).size(withAttributes: attrs)

        // The menu bar is 22pt; leaving a little air top and bottom stops the
        // plate looking like it is jammed against the screen edge.
        let height: CGFloat = 18
        let padding: CGFloat = 6
        let width = ceil(measured.width) + padding * 2

        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            let path = NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5)
            background.setFill()
            path.fill()
            let y = (rect.height - measured.height) / 2
            (text as NSString).draw(at: NSPoint(x: padding, y: y), withAttributes: attrs)
            return true
        }
        // Not a template: the whole point is that these are our colours, not
        // the system's tint applied to a silhouette.
        image.isTemplate = false
        return image
    }
}

// MARK: - Client

final class UsageClient {
    var port: Int
    private let session: URLSession

    init(port: Int) {
        self.port = port
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 6
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    var baseURL: String { "http://127.0.0.1:\(port)" }


    /// POSTs to /api/limits/refresh, which may step over a rate-limit backoff
    /// because a person asked. Fire and forget: the caller re-reads state after.
    func forceUpstreamRefresh(_ done: @escaping () -> Void) {
        guard let url = URL(string: "\(baseURL)/api/limits/refresh") else { done(); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // The server's CSRF gate checks these; without them the call is refused.
        req.setValue(baseURL, forHTTPHeaderField: "Origin")
        req.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        req.timeoutInterval = 20
        URLSession.shared.dataTask(with: req) { _, _, _ in done() }.resume()
    }

    func fetch(_ completion: @escaping (Result<MenubarState, Error>) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/menubar") else { return }
        session.dataTask(with: url) { data, _, error in
            if let error = error { return completion(.failure(error)) }
            guard let data = data else {
                return completion(.failure(NSError(domain: "usage-bar", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Empty response"])))
            }
            do { completion(.success(try JSONDecoder().decode(MenubarState.self, from: data))) }
            catch { completion(.failure(error)) }
        }.resume()
    }
}

// MARK: - Backend process

/// Appends to ~/Library/Logs/UsageBar.log. An app with no window and no Dock
/// icon has nowhere to show an error, so every interesting event goes here.
enum Log {
    static let url: URL = {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("UsageBar.log")
    }()

    private static let queue = DispatchQueue(label: "dev.wfoster.usagebar.log")

    static func write(_ message: String) {
        NSLog("usage-bar: %@", message)
        let line = "\(ISO8601DateFormatter().string(from: Date()))  \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        // Serialised: the backend's stdout and stderr readers both log from
        // their own queues, and interleaved writes would corrupt lines.
        queue.async {
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                _ = try? h.seekToEnd()
                try? h.write(contentsOf: data)
            } else {
                try? data.write(to: url)
            }
        }
    }
}

/// Starts `node src/cli.js serve` when nothing is already answering on the port,
/// so the menu bar app is the only thing the user has to launch.
final class Backend {
    private var process: Process?
    private let repoPath: String
    private let port: Int

    /// Why the backend is not running, in words fit to show in the menu.
    private(set) var status: String?
    /// Distinguishes "tried and failed" from "has not tried yet" — they look
    /// identical from the outside and have completely different fixes.
    private(set) var hasAttempted = false
    private(set) var nodePath: String?
    private var lastStderr: String = ""

    init(repoPath: String, port: Int) {
        self.repoPath = repoPath
        self.port = port
    }

    var isRunning: Bool { process?.isRunning == true }

    func startIfNeeded() {
        // A process that has exited must not block a restart: checking only for
        // non-nil would wedge the app forever after a single crashed backend.
        if let p = process, p.isRunning { return }
        process = nil
        hasAttempted = true

        let cli = (repoPath as NSString).appendingPathComponent("src/cli.js")
        guard FileManager.default.fileExists(atPath: cli) else {
            status = "No CLI at \(cli)"
            Log.write("\(status!) — fix: defaults write dev.wfoster.usagebar UsageBarRepoPath -string <repo>")
            return
        }
        guard let node = Backend.findNode() else {
            nodePath = nil
            status = "node not found on PATH"
            Log.write("node not found — checked Homebrew, /usr/local, /usr/bin, nvm/fnm, and login+interactive shells")
            return
        }

        nodePath = node
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "serve", "--port", String(port)]

        // Keep the backend's own diagnostics. Discarding them (as this used to)
        // turns every startup failure into an unexplained "not reachable".
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        for (pipe, tag) in [(out, "out"), (err, "err")] {
            pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                let d = h.availableData
                guard !d.isEmpty, let text = String(data: d, encoding: .utf8) else { return }
                for line in text.split(separator: "\n") where !line.isEmpty {
                    Log.write("backend/\(tag): \(line)")
                    if tag == "err" { self?.lastStderr = String(line) }
                }
            }
        }

        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.process = nil
                if code != 0 {
                    self.status = self.lastStderr.isEmpty
                        ? "Backend exited with code \(code)"
                        : self.lastStderr
                }
                Log.write("backend exited with code \(code)")
            }
        }

        do {
            try p.run()
            process = p
            status = nil
            Log.write("started backend: \(node) \(cli) serve --port \(port)")
        } catch {
            status = "Could not start node: \(error.localizedDescription)"
            Log.write(status!)
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private static func findNode() -> String? {
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

        // Version managers keep node under a versioned directory, so glob for the
        // newest rather than guessing a version.
        let fm = FileManager.default
        for base in ["~/.nvm/versions/node", "~/.local/share/fnm/node-versions", "~/.asdf/installs/nodejs"] {
            let dir = NSString(string: base).expandingTildeInPath
            guard let versions = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for v in versions.sorted(by: >) {
                for suffix in ["bin/node", "installation/bin/node"] {
                    let candidate = "\(dir)/\(v)/\(suffix)"
                    if fm.isExecutableFile(atPath: candidate) { candidates.append(candidate) }
                }
            }
        }
        for c in candidates where fm.isExecutableFile(atPath: c) { return c }

        // Finally ask a shell. `-l` alone sources .zprofile but NOT .zshrc, which
        // is where nvm and fnm are almost always initialised — so try the
        // interactive form too before giving up.
        for args in [["-lc", "command -v node"], ["-ilc", "command -v node"]] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { continue }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let out = String(data: data, encoding: .utf8)?
                .split(separator: "\n").last.map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let out = out, !out.isEmpty, fm.isExecutableFile(atPath: out) { return out }
        }
        return nil
    }
}

/// A menu row that paints the chosen scheme colour behind its own text.
///
/// NSMenu draws its background from a system material and offers no hook for
/// tinting it, so the only way to carry the theme into the dropdown is to own a
/// row outright. One row is enough: it anchors the menu to the colour you picked
/// without fighting the system material for everything else.
final class PlateHeaderView: NSView {
    private let title: String
    private let detail: String
    private let background: NSColor
    private let ink: NSColor

    init(title: String, detail: String, background: NSColor, ink: NSColor) {
        self.title = title
        self.detail = detail
        self.background = background
        self.ink = ink
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 46))
        autoresizingMask = [.width]
    }

    required init?(coder: NSCoder) { fatalError("PlateHeaderView is never archived") }

    override func draw(_ dirtyRect: NSRect) {
        // Inset so the plate reads as a card inside the menu, rather than a band
        // butting up against the menu's own rounded corners.
        let plate = bounds.insetBy(dx: 10, dy: 4)
        // Filling the path directly rather than clipping to it: setClip would
        // persist for the rest of this draw call.
        background.setFill()
        NSBezierPath(roundedRect: plate, xRadius: 7, yRadius: 7).fill()

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: ink,
        ]
        let detailAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            // The derived ink is guaranteed readable; softening it keeps the
            // hierarchy without introducing a second, unverified colour.
            .foregroundColor: ink.withAlphaComponent(0.8),
        ]
        let x = plate.minX + 12
        (title as NSString).draw(at: NSPoint(x: x, y: plate.minY + 19), withAttributes: titleAttrs)
        (detail as NSString).draw(at: NSPoint(x: x, y: plate.minY + 5), withAttributes: detailAttrs)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var client: UsageClient!
    private var backend: Backend?
    private var state: MenubarState?
    private var lastError: String?
    private var consecutiveFailures = 0
    private var appearanceObserver: NSObjectProtocol?

    /// Startup is a state, not a failure. A cold launch has to spawn node, bind
    /// a port, read credentials and index the transcript archive before it can
    /// say anything true — reporting that window as "not reachable" is both
    /// alarming and wrong.
    private let launchedAt = Date()
    private static let startupGrace: TimeInterval = 25
    /// A full archive index is seconds, not minutes. Past this, something is
    /// wrong and a spinner is no longer an honest thing to show.
    private static let indexingGrace: TimeInterval = 90
    private static let spinner = ["◐", "◓", "◑", "◒"]
    private var spinnerTimer: Timer?
    private var spinnerFrame = 0
    private var connectedOnce = false

    /// True while a first real reading is still plausibly on its way.
    private var isStarting: Bool {
        if connectedOnce { return false }
        if let s = state {
            // The server is answering. Only its OWN "still starting" counts as
            // startup — anything else is a settled state that must be shown.
            // Treating every not-yet-ready reply as progress meant a backend
            // that could never become ready (a rate-limited usage endpoint)
            // spun this indicator forever while hiding the actual reason.
            guard !s.ok, s.message == "Starting…" else { return false }
            // And even that is bounded: indexing does not take minutes, so if
            // it claims to still be starting after this long, show it plainly.
            return Date().timeIntervalSince(launchedAt) < AppDelegate.indexingGrace
        }
        // A diagnosed failure is not a slow start. Say so immediately rather
        // than making the user watch a spinner that will never resolve.
        if backend?.status != nil { return false }
        return Date().timeIntervalSince(launchedAt) < AppDelegate.startupGrace
    }

    private var startupMessage: String {
        // Prefer whatever the server says about itself; a fixed string here
        // claimed we were indexing when we were really waiting on a 429.
        if let s = state { return s.message ?? "Indexing sessions…" }
        if backend?.isRunning == true { return "Starting the local server…" }
        if backend?.hasAttempted == true { return "Launching node…" }
        return "Connecting…"
    }

    private let defaults = UserDefaults.standard
    private var port: Int {
        let p = defaults.integer(forKey: "UsageBarPort")
        return p > 0 ? p : 4317
    }
    /// Where `src/cli.js` lives, and how that answer was reached — the origin
    /// matters because a wrong repo path presents as "backend not reachable",
    /// which points at the network rather than at the path.
    struct RepoResolution { let path: String; let origin: String }

    private static func hasCLI(_ dir: String) -> Bool {
        FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent("src/cli.js"))
    }

    var repo: RepoResolution {
        // Most explicit first: an override the user set deliberately.
        if let p = defaults.string(forKey: "UsageBarRepoPath"), AppDelegate.hasCLI(p) {
            return RepoResolution(path: p, origin: "defaults")
        }
        // Then the working copy a development build points at — checked before
        // the bundled copy so edits to the CLI take effect without a rebuild.
        // On anyone else's machine this path does not exist and we fall through.
        if let p = Bundle.main.object(forInfoDictionaryKey: "UsageBarRepoPath") as? String,
           AppDelegate.hasCLI(p) {
            return RepoResolution(path: p, origin: "Info.plist")
        }
        // Then the copy shipped inside the app. This is what a DMG install uses.
        if let res = Bundle.main.resourcePath {
            let bundled = (res as NSString).appendingPathComponent("usage-bar")
            if AppDelegate.hasCLI(bundled) {
                return RepoResolution(path: bundled, origin: "bundled in the app")
            }
        }
        // Then just look: the .app is built into mac/build, so the repo is a
        // few levels up. This is what makes a fresh build work unconfigured.
        var dir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        for _ in 0..<6 {
            if AppDelegate.hasCLI(dir) { return RepoResolution(path: dir, origin: "found above the bundle") }
            let parent = (dir as NSString).deletingLastPathComponent
            if parent == dir { break }
            dir = parent
        }
        let guess = defaults.string(forKey: "UsageBarRepoPath")
            ?? (Bundle.main.object(forInfoDictionaryKey: "UsageBarRepoPath") as? String)
            ?? (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        return RepoResolution(path: guess, origin: "NOT FOUND — no src/cli.js under any candidate")
    }

    private var repoPath: String { repo.path }

    /// Read by the launch watchdog in main. Silence here means the run loop is
    /// turning but AppKit never handed control over.
    private(set) var didLaunch = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        didLaunch = true
        let r = repo
        Log.write("launched · pid \(ProcessInfo.processInfo.processIdentifier) · port \(port) "
                + "· repo \(r.path) (\(r.origin))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else {
            // No button means no menu bar slot at all — worth saying out loud
            // rather than exiting silently with nothing on screen.
            Log.write("FATAL: the status bar gave us no button; is the menu bar full?")
            return
        }
        // Paint something immediately: the app has no other surface, so an
        // empty menu bar is indistinguishable from a crash. Belt and braces —
        // a symbol AND text, so a failure of either still leaves something.
        for name in ["gauge.with.dots.needle.33percent", "gauge", "circle.lefthalf.fill", "circle"] {
            if let img = NSImage(systemSymbolName: name, accessibilityDescription: "Claude usage") {
                img.isTemplate = true
                button.image = img
                button.imagePosition = .imageLeading
                Log.write("status icon: \(name)")
                break
            }
        }
        button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        button.attributedTitle = NSAttributedString(
            string: " ––",
            attributes: [.foregroundColor: NSColor.labelColor,
                         .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)])
        client = UsageClient(port: port)
        backend = Backend(repoPath: repoPath, port: port)

        // Only after the collaborators exist: buildMenu reads them.
        statusItem.menu = buildMenu()

        // Deferred: the status bar assigns geometry on the next runloop pass.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let b = self.statusItem.button else { return }
            let w = b.window?.frame.width ?? -1
            let x = b.window?.frame.origin.x ?? -1
            let visible = b.window?.isVisible ?? false
            Log.write("status item geometry: width \(w), x \(x), visible \(visible), length \(self.statusItem.length)")
            if b.window == nil || w <= 0 {
                Log.write("WARNING: the item has no on-screen slot — the menu bar is probably full. "
                        + "Quit another menu bar app, or hold Command and drag icons to make room.")
            }
        }
        Log.write("status item created")

        startSpinner()
        refresh()

        // Following the system means repainting when the system changes.
        appearanceObserver = DistributedNotificationCenter.default.addObserver(
            forName: Notification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil, queue: .main) { [weak self] _ in self?.render() }

        // Poll hard until the first reading lands, then back off. A 5s cadence
        // during startup makes a 2s launch feel like a 7s one.
        installRefreshTimer(every: 1)
    }

    /// scheduledTimer installs in .default mode only; adding it again would
    /// double the firing rate. Install manually in .common so it keeps ticking
    /// while a menu is open.
    private func installRefreshTimer(every interval: TimeInterval) {
        timer?.invalidate()
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.refresh() }
        t.tolerance = interval / 4
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func startSpinner() {
        spinnerTimer?.invalidate()
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            guard self.isStarting else { self.stopSpinner(); self.render(); return }
            self.spinnerFrame += 1
            self.renderButton()
        }
        RunLoop.main.add(t, forMode: .common)
        spinnerTimer = t
    }

    private func stopSpinner() {
        spinnerTimer?.invalidate()
        spinnerTimer = nil
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        stopSpinner()
        if let o = appearanceObserver { DistributedNotificationCenter.default.removeObserver(o) }
        backend?.stop()
    }

    // MARK: Refresh

    private func refresh() {
        client.fetch { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case .success(let s):
                    if self.state == nil { Log.write("connected · \(s.glance.display)% \(s.glance.suffix)") }
                    self.state = s
                    self.lastError = nil
                    self.consecutiveFailures = 0
                    if s.ok, s.glance.known, !self.connectedOnce {
                        self.connectedOnce = true
                        self.stopSpinner()
                        let secs = String(format: "%.1f", Date().timeIntervalSince(self.launchedAt))
                        Log.write("ready after \(secs)s")
                        self.installRefreshTimer(every: 5)
                    }
                case .failure(let e):
                    self.lastError = e.localizedDescription
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures == 1 || self.consecutiveFailures % 12 == 0 {
                        Log.write("fetch failed (\(self.consecutiveFailures)): \(e.localizedDescription)")
                    }
                    // The backend may have died or never started. Retry on a
                    // backoff rather than once: a single attempt leaves the app
                    // permanently dead if the first try lost a race with launch.
                    // Start on the very first refusal rather than after a fixed
                    // delay: a connection refused comes back in milliseconds, so
                    // waiting adds latency without buying certainty.
                    if [1, 6, 18, 54].contains(self.consecutiveFailures) {
                        self.backend?.startIfNeeded()
                    }
                }
                self.render()
            }
        }
    }

    private func render() {
        renderButton()
        statusItem.menu = buildMenu()
    }

    /// A previous paint may have left an image behind; a title alone will not
    /// replace it, and the two would render side by side.
    private func clearPlate(_ button: NSStatusBarButton) {
        button.image = nil
        button.imagePosition = .noImage
        button.toolTip = nil
    }

    private func renderButton() {
        guard let button = statusItem.button else { return }
        // Spawning node, binding, reading credentials and indexing are one
        // continuous wait from the user's side, so show one continuous state.
        if isStarting {
            let glyph = AppDelegate.spinner[spinnerFrame % AppDelegate.spinner.count]
            clearPlate(button)
            button.attributedTitle = NSAttributedString(
                string: "\(glyph) ··",
                attributes: [.foregroundColor: NSColor.secondaryLabelColor,
                             .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)])
            return
        }
        guard let s = state, s.ok, s.glance.known else {
            clearPlate(button)
            button.attributedTitle = NSAttributedString(
                string: "◐ !",
                attributes: [.foregroundColor: NSColor.secondaryLabelColor,
                             .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)])
            return
        }
        let pct = Int(s.glance.display.rounded())
        let glyph = s.activeSessions.contains(where: { $0.busy }) ? "◉" : "◐"
        let label = "\(glyph) \(pct)% \(s.glance.suffix)"
        let chip = Palette.chip(Palette.current(s.theme), severity: s.glance.severity)

        // With a plate, the label is drawn into an image so we own every pixel
        // of it. Without one we are on the wallpaper, where the system's own
        // label colour is the only thing guaranteed to stay legible.
        if let chip = chip, let bg = NSColor(hex: chip.background) {
            button.image = Chipboard.image(text: label, background: bg, ink: Palette.color(chip.text))
            button.imagePosition = .imageOnly
            button.attributedTitle = NSAttributedString(string: "")
            button.toolTip = "\(s.glance.label): \(pct)% \(s.glance.suffix)"
            return
        }

        button.image = nil
        button.imagePosition = .noImage
        button.attributedTitle = NSAttributedString(
            string: label,
            attributes: [
                .foregroundColor: Palette.color(chip?.text),   // nil -> labelColor
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            ])
    }

    // MARK: Menu

    /// Menu text colours. Unlike the menu bar, a menu's background follows the
    /// system appearance and is near-opaque, so the palette can be used here —
    /// every one of these is contrast-checked against the menu material.
    private var menuInk: NSColor { NSColor(hex: Palette.menu(state?.theme)?.ink) ?? .labelColor }
    private var menuDim: NSColor { NSColor(hex: Palette.menu(state?.theme)?.inkDim) ?? .secondaryLabelColor }
    private var menuFaint: NSColor { menuDim.withAlphaComponent(0.72) }
    private var menuAccent: NSColor { NSColor(hex: Palette.menu(state?.theme)?.accent) ?? .controlAccentColor }

    private func mono(_ text: String, size: CGFloat = 12, color: NSColor? = nil) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular),
            .foregroundColor: color ?? menuInk,
        ])
    }

    private func disabledItem(_ attributed: NSAttributedString) -> NSMenuItem {
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.attributedTitle = attributed
        item.isEnabled = false
        return item
    }

    private func limitItems(_ l: LimitView) -> [NSMenuItem] {
        let pct = l.percent ?? 0
        // The server resolves the bar's glyphs and colour from the configured
        // gauge style, so changing either needs no rebuild. Falling back keeps
        // an older backend working.
        let color = l.color?.current() ?? menuInk
        let bar = l.bar ?? Fmt.bar(pct)
        let head = String(format: "%@  %@ %3.0f%% used", l.label.padded(to: 20), bar, pct)

        var notes: [String] = []
        if let secs = Fmt.secondsUntil(l.resetsAt) { notes.append("resets in \(Fmt.duration(secs))") }
        if let p = l.projection, let perHour = p.percentPerHour, perHour > 0.05 {
            if let mins = p.minutesToExhaust, p.beatsReset != true {
                notes.append("exhausts in \(Fmt.duration(mins * 60))")
            } else {
                notes.append(String(format: "%.1f%%/h", perHour))
            }
        }

        var items = [disabledItem(mono(head, color: color))]
        if !notes.isEmpty {
            items.append(disabledItem(mono("  " + notes.joined(separator: " · "), size: 10, color: menuDim)))
        }
        return items
    }

    /// The dropdown's headline. Uses the scheme colour whenever there is one,
    /// even if the menu bar itself is unplated: "no plate" exists because the
    /// wallpaper is unpredictable, and that reason does not apply in here.
    private func addGlanceHeader(to menu: NSMenu, _ s: MenubarState) {
        let pct = Int(s.glance.display.rounded())
        let title = "\(pct)% \(s.glance.suffix)"
        var detail = s.glance.label
        if let secs = Fmt.secondsUntil(s.session?.resetsAt) {
            detail += " · resets in \(Fmt.duration(secs))"
        }

        let m = Palette.menu(s.theme)
        if let bg = NSColor(hex: m?.headerBackground), let ink = NSColor(hex: m?.headerText) {
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.view = PlateHeaderView(title: title, detail: detail, background: bg, ink: ink)
            item.isEnabled = false
            menu.addItem(item)
            return
        }
        menu.addItem(disabledItem(mono("\(detail): \(title)", size: 11, color: menuDim)))
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        guard let s = state else {
            if isStarting {
                menu.addItem(disabledItem(mono(startupMessage, size: 11, color: menuDim)))
                menu.addItem(disabledItem(mono("  First run indexes the whole archive; later starts are quicker.",
                                               size: 10, color: menuFaint)))
            } else {
                menu.addItem(disabledItem(mono("Backend not reachable on port \(port)",
                                               size: 11, color: .systemOrange)))
                // The backend's own reason beats the socket error every time.
                if let why = backend?.status {
                    menu.addItem(disabledItem(mono("  \(why)", size: 10, color: menuDim)))
                } else if backend?.isRunning == true {
                    menu.addItem(disabledItem(mono("  Running but not answering yet.",
                                                   size: 10, color: menuFaint)))
                } else if backend?.hasAttempted == false {
                    menu.addItem(disabledItem(mono("  Not started yet.", size: 10, color: menuFaint)))
                }

                // The two facts that decide every case of this, spelled out so
                // the fix does not require reading a log first.
                let r = repo
                menu.addItem(disabledItem(mono("  repo:  \(r.path)  (\(r.origin))",
                                               size: 10, color: menuFaint)))
                let nodeDesc = backend?.nodePath ?? "not found"
                menu.addItem(disabledItem(mono("  node:  \(nodeDesc)", size: 10, color: menuFaint)))

                for line in ["Log:  ~/Library/Logs/UsageBar.log", "Diagnose:  ./mac/doctor.sh"] {
                    menu.addItem(disabledItem(mono("  \(line)", size: 10, color: menuFaint)))
                }

                let retry = NSMenuItem(title: "Restart Backend", action: #selector(restartBackend), keyEquivalent: "")
                retry.target = self
                menu.addItem(retry)

                let openLog = NSMenuItem(title: "Reveal Log in Finder", action: #selector(revealLog), keyEquivalent: "")
                openLog.target = self
                menu.addItem(openLog)
            }
            menu.addItem(.separator())
            addFooter(to: menu)
            return menu
        }

        if s.stale == true, let why = s.staleMessage {
            // Not orange: the reading below is real, just held over. Saying
            // "error" here would be a lie and would train the user to ignore it.
            var line = why
            if let secs = Fmt.secondsUntil(s.retryAt), secs > 0 {
                line += " Retrying in \(Fmt.duration(secs))."
            }
            menu.addItem(disabledItem(mono(line, size: 10, color: menuFaint)))
        }

        if !s.ok {
            // Orange means something is wrong. While starting, nothing is.
            let starting = isStarting
            menu.addItem(disabledItem(mono(starting ? startupMessage : (s.message ?? "Usage unavailable"),
                                           size: 11,
                                           color: starting ? menuDim : .systemOrange)))
            if !starting, let secs = Fmt.secondsUntil(s.retryAt), secs > 0 {
                menu.addItem(disabledItem(mono("  Retrying in \(Fmt.duration(secs)) — or use Refresh Now.",
                                               size: 10, color: menuFaint)))
            }
            menu.addItem(.separator())
        }

        addGlanceHeader(to: menu, s)
        if let sess = s.session { for i in limitItems(sess) { menu.addItem(i) } }
        for w in s.weekly { for i in limitItems(w) { menu.addItem(i) } }
        if let plan = s.plan {
            menu.addItem(disabledItem(mono("  \(plan)", size: 10, color: menuFaint)))
        }

        menu.addItem(.separator())

        let header = s.activeSessions.isEmpty
            ? "No active sessions"
            : String(format: "%d active · %@ · %@/h",
                     s.activeSessions.count,
                     Fmt.money(s.totals.activeCost),
                     Fmt.money(s.totals.activeCostPerMin * 60))
        menu.addItem(disabledItem(mono(header, size: 11, color: menuDim)))

        for session in s.activeSessions {
            let item = NSMenuItem(title: "", action: #selector(openSession(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = session.sessionId

            let mark = session.busy ? "\u{25CF}" : "\u{25CB}"
            let name = (session.title ?? session.project ?? session.sessionId).truncated(to: 34)
            let line = String(format: "%@ %@ %@ %@",
                              mark, name.padded(to: 34),
                              Fmt.tokens(session.tokens).padded(to: 7, right: true),
                              Fmt.money(session.cost).padded(to: 8, right: true))
            let title = NSMutableAttributedString(attributedString: mono(line))
            if session.busy, let accent = NSColor(hex: Palette.menu(s.theme)?.accent) {
                title.addAttribute(.foregroundColor, value: accent, range: NSRange(location: 0, length: 1))
            }
            item.attributedTitle = title

            // Submenu carries the detail so the top level stays scannable.
            let sub = NSMenu()
            sub.autoenablesItems = false
            var detail: [String] = []
            if let m = session.model { detail.append(m.replacingOccurrences(of: "claude-", with: "")) }
            if let b = session.branch { detail.append(b) }
            detail.append(String(format: "context %.0f%%", session.contextPct))
            if session.subagents > 0 {
                let live = session.subagentsActive ?? 0
                detail.append(live > 0 ? "\(live)/\(session.subagents) subagents"
                                       : "\(session.subagents) subagents")
            }
            if session.busy, let tool = session.tool { detail.append("running \(tool)") }
            else if session.busy, let live = session.subagentsActive, live > 0 {
                detail.append("running \(live) agent\(live > 1 ? "s" : "")")
            }
            else if let idle = session.idleMs { detail.append("\(Fmt.duration(idle / 1000)) idle") }
            for d in detail { sub.addItem(disabledItem(mono(d, size: 11, color: menuDim))) }
            sub.addItem(.separator())
            let open = NSMenuItem(title: "Open in dashboard", action: #selector(openSession(_:)), keyEquivalent: "")
            open.target = self
            open.representedObject = session.sessionId
            sub.addItem(open)
            item.submenu = sub

            menu.addItem(item)
        }

        menu.addItem(.separator())
        addFooter(to: menu)
        return menu
    }

    private func addFooter(to menu: NSMenu) {
        let dash = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "u")
        dash.target = self
        menu.addItem(dash)

        let refreshItem = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let settings = NSMenuItem(title: "Settings\u{2026}", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        menu.addItem(.separator())
        menu.addItem(disabledItem(mono("Costs are equivalent API rates,\nnot subscription billing.",
                                       size: 10, color: menuFaint)))

        let about = NSMenuItem(title: "UsageBar \(AppInfo.version) \u{00B7} \(AppInfo.host)",
                               action: #selector(openHomepage), keyEquivalent: "")
        about.target = self
        about.toolTip = "Open \(AppInfo.homepage)"
        menu.addItem(about)

        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    // MARK: Actions

    @objc private func openSession(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let url = URL(string: "\(client.baseURL)/#session=\(id)") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openDashboard() {
        guard let url = URL(string: client.baseURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openHomepage() {
        guard let url = URL(string: AppInfo.homepage) else { return }
        NSWorkspace.shared.open(url)
    }

    /// Credential and transcript locations are edited in the dashboard, so the
    /// menu bar just deep-links to its settings sheet.
    @objc private func openSettings() {
        guard let url = URL(string: "\(client.baseURL)/#settings") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Foreground diagnostics for when there is no menu bar item to click.
    func runCheck() {
        let cli = (repoPath as NSString).appendingPathComponent("src/cli.js")
        // Hoisted rather than inlined: a string literal nested inside a string
        // interpolation is legal but reads badly and trips naive parsers.
        let bundleID = Bundle.main.bundleIdentifier ?? "NIL - the Info plist is not being read"
        let lines = [
            "UsageBar \(AppInfo.version) --check  (\(AppInfo.homepage))",
            "  bundle      \(Bundle.main.bundlePath)",
            "  log         \(Log.url.path)",
            "  port        \(port)",
            "  repo        \(repo.path)",
            "  repo origin \(repo.origin)",
            "  bundle id   \(bundleID)",
            "  cli present \(FileManager.default.fileExists(atPath: cli))",
            "  screens     \(NSScreen.screens.count)",
            "  menu bar    thickness \(NSStatusBar.system.thickness)",
        ]
        for l in lines { print(l) }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "test"
        let hasButton = item.button != nil
        print("  status item button: \(hasButton ? "created" : "NIL — no menu bar slot available")")
        NSStatusBar.system.removeStatusItem(item)

        let sem = DispatchSemaphore(value: 0)
        var reply = "no response"
        UsageClient(port: port).fetch { result in
            switch result {
            case .success(let s): reply = "ok · \(Int(s.glance.display))% \(s.glance.suffix)"
            case .failure(let e): reply = "unreachable · \(e.localizedDescription)"
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 8)
        print("  backend     \(reply)")
    }

    @objc private func refreshNow() {
        // Ask the backend to go upstream, not just to re-serve what it has.
        // Re-reading a cached view cannot recover from a backoff, which is the
        // one situation anyone actually clicks this in.
        client.forceUpstreamRefresh { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
    }

    @objc private func restartBackend() {
        Log.write("manual backend restart requested")
        backend?.stop()
        backend?.startIfNeeded()
        consecutiveFailures = 0
        refresh()
    }

    @objc private func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([Log.url])
    }
}

private extension String {
    func padded(to width: Int, right: Bool = false) -> String {
        let n = count
        guard n < width else { return self }
        let pad = String(repeating: " ", count: width - n)
        return right ? pad + self : self + pad
    }

    func truncated(to width: Int) -> String {
        count <= width ? self : String(prefix(width - 1)) + "\u{2026}"
    }
}

// Logged before AppKit is touched, so an empty log distinguishes "the process
// never started" (Gatekeeper, bad signature, wrong arch) from "it started and
// then failed" — which need completely different fixes.
Log.write("process start · \(Bundle.main.bundlePath)")

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon

// `--check` runs the diagnostics in the foreground and exits, for when there is
// no menu bar item to click.
if CommandLine.arguments.contains("--check") {
    delegate.runCheck()
    exit(0)
}

Log.write("entering run loop")

// A bundle LaunchServices refuses (malformed Info.plist, bad signature) can
// still reach here when run directly, and then sit forever with no UI. Say so.
DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    if !delegate.didLaunch {
        Log.write("WARNING: 3s into the run loop and applicationDidFinishLaunching has not fired — "
                + "the bundle is probably not being accepted by LaunchServices; check the Info plist.")
    }
}

app.run()
