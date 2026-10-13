import AppKit
import Carbon
import Network
import QuartzCore

// The companion owns windows/hotkeys; Spotify owns music state and mutations.
struct Request {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    static func parse(_ data: Data) throws -> Request? {
        guard data.count <= 262144 else { throw MiniError.invalidRequest }
        guard let boundary = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let header = String(data: data[..<boundary.lowerBound], encoding: .utf8) else {
            throw MiniError.invalidRequest
        }
        let lines = header.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1" else { throw MiniError.invalidRequest }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw MiniError.invalidRequest }
            let key = line[..<colon].lowercased()
            guard headers[key] == nil else { throw MiniError.invalidRequest }
            headers[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil,
              let length = Int(headers["content-length"] ?? "0"), (0...250000).contains(length)
        else { throw MiniError.invalidRequest }
        guard data.count >= boundary.upperBound + length else { return nil }
        guard data.count == boundary.upperBound + length else { throw MiniError.invalidRequest }
        return Request(method: String(first[0]), path: String(first[1]), headers: headers,
                       body: data.subdata(in: boundary.upperBound..<data.count))
    }
}

enum MiniError: Error { case invalidRequest, invalidConfig }

let origins = ["https://xpui.app.spotify.com", "https://open.spotify.com"]
let keyCodes: [String: UInt32] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16,
    "t": 17, "o": 31, "u": 32, "i": 34, "p": 35,
    "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "[": 33, "]": 30, "-": 27, "=": 24, "\\": 42,
]

func migratedKeys(_ keys: [String]) -> [String] {
    guard keys.count == 4 else { return keys }
    return keys + [(["r", "u", "d", "x"] + Array(keyCodes.keys).sorted()).first { !keys.contains($0) && !$0.allSatisfy(\.isNumber) }!]
}

func validKeys(_ keys: [String], modifiers: UInt32) -> Bool {
    let all = keys
    let allowed = UInt32(cmdKey | optionKey | controlKey | shiftKey)
    return keys.count == 5 && all.allSatisfy { keyCodes[$0] != nil } &&
        Set(all).count == all.count && modifiers & ~allowed == 0 &&
        modifiers & UInt32(cmdKey | optionKey | controlKey) != 0
}

func loadConfig(_ url: URL) throws -> [String: Any] {
    guard let data = try? Data(contentsOf: url),
          var config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let token = config["token"] as? String,
          token.utf8.count == 64,
          token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          let port = config["port"] as? NSNumber, CFGetTypeID(port) != CFBooleanGetTypeID(),
          (1024...65535).contains(port.doubleValue), port.doubleValue == Double(port.intValue)
    else { throw MiniError.invalidConfig }
    let keys = migratedKeys((config["keys"] ?? ["m", "h", "l", "p", "r"]) as? [String] ?? [])
    guard let modifiers = (config["modifiers"] ?? 6400) as? NSNumber,
          CFGetTypeID(modifiers) != CFBooleanGetTypeID(),
          (0...Double(UInt32.max)).contains(modifiers.doubleValue),
          modifiers.doubleValue == Double(modifiers.uint32Value),
          validKeys(keys, modifiers: modifiers.uint32Value)
    else { throw MiniError.invalidConfig }
    config["keys"] = keys
    return config
}

final class SquarePanel: NSPanel {
    var visibilityChanged: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
    override func orderOut(_ sender: Any?) { super.orderOut(sender); visibilityChanged?() }
}

final class Gradient: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSGradient(colors: [NSColor.black.withAlphaComponent(0.94),
                            NSColor.black.withAlphaComponent(0)])?.draw(in: bounds, angle: 90)
    }
}

final class MusicButton: NSButton {
    private var hoverArea: NSTrackingArea?
    var hovered = false { didSet { refreshAppearance() } }
    private var pressing = false
    fileprivate var keyboardFocused = false { didSet { refreshAppearance() } }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        keyboardFocused = accepted && NSApp.currentEvent?.type == .keyDown
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { keyboardFocused = false }
        return resigned
    }

    override var isEnabled: Bool {
        didSet {
            refreshAppearance()
            if oldValue != isEnabled { window?.invalidateCursorRects(for: self) }
        }
    }

    override func updateTrackingAreas() {
        if let hoverArea { removeTrackingArea(hoverArea) }
        hoverArea = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(hoverArea!)
        super.updateTrackingAreas()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: isEnabled ? .pointingHand : .arrow)
    }
    override func mouseDown(with event: NSEvent) {
        (window?.firstResponder as? MusicButton)?.keyboardFocused = false
        keyboardFocused = false
        guard isEnabled else { return }
        pressing = true
        refreshAppearance()
        displayIfNeeded()
        super.mouseDown(with: event)
        pressing = false
        refreshAppearance()
    }

    func refreshAppearance() {
        guard let layer else { return }
        let scale = isEnabled && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ?
            (pressing ? 0.92 : hovered ? 1.1 : 1) : 1
        var transform = CATransform3DMakeScale(scale, scale, 1)
        // AppKit anchors view layers at a corner; keep growth centered on the icon.
        transform.m41 = layer.bounds.width * (0.5 - layer.anchorPoint.x) * (1 - scale)
        transform.m42 = layer.bounds.height * (0.5 - layer.anchorPoint.y) * (1 - scale)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.transform = transform
        layer.cornerRadius = 4
        layer.borderColor = NSColor.white.cgColor
        layer.borderWidth = keyboardFocused ? 1.5 : 0
        CATransaction.commit()
    }
}

// Keep the confirmed snapshot separate so failed or expired commands restore it.
func displayedState(_ snapshot: [String: Any], _ commands: [[String: Any]]) -> [String: Any] {
    var state = snapshot
    for command in commands where command["uri"] as? String == snapshot["uri"] as? String &&
        command["account"] as? String == snapshot["account"] as? String {
        let action = command["action"] as? String
        if let value = command["value"] as? Bool {
            if action == "like" {
                state["liked"] = value
                if !value { state["loved"] = false }
            }
            if action == "love" {
                state["loved"] = value
                if value { state["liked"] = true }
            }
        }
        if action == "remove" || action == "undo" {
            let original = command["removal"] as? [String: Any] ?? [:]
            var removal = snapshot["removal"] as? [String: Any] ?? [:]
            if ["context", "itemUid", "provider"].allSatisfy({ original[$0] as? String == removal[$0] as? String }) {
                removal["action"] = action == "remove" ? "undo" : "remove"
                state["removal"] = removal
            }
        }
    }
    return state
}

final class Mini: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let configURL: URL
    var config: [String: Any]
    var token: String { config["token"] as! String }
    var port: UInt16 { (config["port"] as! NSNumber).uint16Value }
    var keys: [String] { config["keys"] as? [String] ?? ["m", "h", "l", "p", "r"] }
    var modifiers: UInt32 { (config["modifiers"] as? NSNumber)?.uint32Value ?? UInt32(cmdKey | optionKey | controlKey) }
    var listener: NWListener?
    var panel: SquarePanel!
    var shortcuts: [UInt32: EventHotKeyRef] = [:]
    var eventHandler: EventHandlerRef?
    var pressed = Set<UInt32>()
    var hotkeyEvents = 0
    var snapshot: [String: Any] = [:]
    var lastSync = Date.distantPast
    var commands: [[String: Any]] = []
    var pendingSeek: [String: Any]?
    var seekReply: (() -> Void)?
    var seekTimeout: DispatchWorkItem?
    var musicResults: [[String: Any]] = []
    var imageURL = ""
    var imageTask: URLSessionDataTask?
    var visibleActions = false
    let artwork = NSImageView()
    let shade = Gradient()
    let title = NSTextField(labelWithString: "Waiting for Spotify")
    let artist = NSTextField(labelWithString: "Artist unavailable")
    let album = NSTextField(labelWithString: "Album unavailable")
    let queueButton = MusicButton()
    let queueBadge = CATextLayer()
    let notice = NSTextField(labelWithString: "Connecting to Spotify…")
    var buttons: [MusicButton] = []

    init(configURL: URL) throws {
        self.configURL = configURL
        self.config = try loadConfig(configURL)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let showInitially = config["visible"] as? Bool ?? true
        makePanel()
        installHotkeyHandler()
        registerToggle()
        if showInitially { panel.orderFrontRegardless(); save() }
        do {
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
            listener = try NWListener(using: params)
            listener?.newConnectionHandler = { [weak self] connection in self?.receive(connection) }
            listener?.stateUpdateHandler = { [weak self] state in
                if case .failed(let error) = state {
                    self?.showNotice("Connection failed: \(error.localizedDescription)")
                    fputs("Mini Player listener failed: \(error)\n", stderr)
                }
            }
            listener?.start(queue: .main)
        } catch { showNotice("Could not start connection: \(error.localizedDescription)") }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if Date().timeIntervalSince(self.lastSync) > 4 {
                self.showNotice("Spotify disconnected — actions disabled")
                self.buttons.forEach { $0.isEnabled = false }
                self.queueButton.isEnabled = false
                self.queueBadge.isHidden = true
            }
            let now = Date().timeIntervalSince1970 * 1000
            if self.commands.contains(where: { ($0["expires"] as? Double ?? 0) + 10000 < now }) {
                let expired = self.commands.filter { ($0["expires"] as? Double ?? 0) + 10000 < now }
                self.complete(expired.map { ["id": $0["id"]!, "ok": false,
                    "message": "Action timed out — check Spotify before retrying"] })
            }
            self.refreshActionHotkeys()
        }
    }

    func makePanel() {
        let savedBounds = config["bounds"] as? [Double]
        panel = SquarePanel(contentRect: NSRect(x: 100, y: 100, width: 320, height: 320),
            styleMask: [.titled, .fullSizeContentView, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Mini Player"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.visibilityChanged = { [weak self] in self?.refreshActionHotkeys() }
        panel.delegate = self
        panel.isFloatingPanel = config["alwaysOnTop"] as? Bool ?? true
        panel.level = panel.isFloatingPanel ? .floating : .normal
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.aspectRatio = NSSize(width: 1, height: 1)
        panel.minSize = NSSize(width: 140, height: 140)
        panel.maxSize = NSSize(width: 640, height: 640)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        if #available(macOS 14.0, *) { panel.collectionBehavior.insert(.canJoinAllApplications) }
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.backgroundColor = .black
        panel.isOpaque = true
        let content = NSView()
        panel.contentView = content
        artwork.imageScaling = .scaleProportionallyUpOrDown
        artwork.setAccessibilityLabel("Playing album artwork")
        content.addSubview(artwork)
        content.addSubview(shade)
        for label in [title, artist, album, notice] {
            label.textColor = .white
            label.lineBreakMode = .byTruncatingTail
            content.addSubview(label)
        }
        notice.alignment = .center
        queueButton.image = NSImage(systemSymbolName: "list.bullet", accessibilityDescription: "Queue")
        queueButton.target = self
        queueButton.action = #selector(openQueue)
        queueButton.bezelStyle = .inline
        queueButton.isBordered = false
        queueButton.focusRingType = .none
        (queueButton.cell as? NSButtonCell)?.highlightsBy = []
        queueButton.contentTintColor = .white
        queueButton.wantsLayer = true
        queueButton.setAccessibilityLabel("Queue")
        queueButton.isEnabled = false
        queueBadge.backgroundColor = NSColor(srgbRed: 29 / 255, green: 185 / 255, blue: 84 / 255, alpha: 1).cgColor
        queueBadge.foregroundColor = NSColor.black.cgColor
        queueBadge.alignmentMode = .center
        queueBadge.isHidden = true
        queueButton.layer?.addSublayer(queueBadge)
        for (index, symbol) in ["heart", "star", "plus"].enumerated() {
            let button = MusicButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: ["Love", "Like", "Add to playlists"][index])!,
                                  target: self, action: #selector(clicked(_:)))
            button.tag = index
            button.bezelStyle = .inline
            button.isBordered = false
            button.focusRingType = .none
            (button.cell as? NSButtonCell)?.highlightsBy = []
            button.contentTintColor = .white
            button.wantsLayer = true
            button.setAccessibilityLabel(["Love", "Like", "Add to playlists"][index])
            content.addSubview(button)
            buttons.append(button)
        }
        content.addSubview(queueButton)
        let menu = NSMenu()
        for (text, action) in [("Hide Mini Player", #selector(toggle)),
                               ("Always on Top", #selector(toggleAlwaysOnTop(_:)))] {
            let item = NSMenuItem(title: text, action: action, keyEquivalent: "")
            item.target = self
            if action == #selector(toggleAlwaysOnTop(_:)) { item.state = panel.isFloatingPanel ? .on : .off }
            menu.addItem(item)
        }
        for view in [content] + content.subviews { view.menu = menu }
        if let bounds = savedBounds, bounds.count == 3,
           bounds.allSatisfy({ $0.isFinite }), (140...640).contains(bounds[2]) {
            panel.setFrame(NSRect(x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[2]), display: false)
        } else {
            panel.setFrame(NSRect(x: 100, y: 100, width: 320, height: 320), display: false)
        }
        clampPosition()
        layout()
    }

    func layout() {
        let size = panel.contentView!.bounds.size
        let scale = size.width / 320
        let padding = max(6, 16 * scale)
        let gap = max(2, 4 * scale)
        let buttonSize = max(28, 44 * scale)
        let buttonGap = 10 * scale
        artwork.frame = NSRect(origin: .zero, size: size)
        let badgeFont = NSFont.monospacedDigitSystemFont(ofSize: max(11, 11 * scale), weight: .bold)
        let badgeHeight = max(18, 18 * scale)
        let badgeWidth = max(badgeHeight, ceil((queueBadge.string as? NSString ?? "").size(withAttributes: [.font: badgeFont]).width) + 8 * scale)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        queueBadge.font = badgeFont
        queueBadge.fontSize = badgeFont.pointSize
        queueBadge.contentsScale = panel.backingScaleFactor
        queueBadge.cornerRadius = badgeHeight / 2
        queueBadge.frame = CGRect(x: buttonSize - badgeWidth, y: 0,
            width: badgeWidth, height: badgeHeight)
        CATransaction.commit()
        let controls = buttons + [queueButton]
        for (index, button) in controls.enumerated() {
            let rowWidth = CGFloat(controls.count) * buttonSize + CGFloat(controls.count - 1) * buttonGap
            button.frame = NSRect(x: (size.width - rowWidth) / 2 + CGFloat(index) * (buttonSize + buttonGap),
                y: max(3, 6 * scale), width: buttonSize, height: buttonSize)
            button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: max(14, 16 * scale), weight: .regular)
            button.refreshAppearance()
        }
        var y = buttons[0].frame.maxY + gap
        for (label, baseSize, minimum) in [(notice, 12.0, 12.0), (album, 12, 12), (artist, 14, 12), (title, 19, 14)] {
            label.font = .systemFont(ofSize: max(minimum, baseSize * scale), weight: label === title ? .semibold : .regular)
            let height = ceil(label.font!.ascender - label.font!.descender + label.font!.leading) + 2
            label.frame = NSRect(x: padding, y: y, width: size.width - 2 * padding, height: height)
            y = label.frame.maxY + gap
        }
        shade.frame = NSRect(x: 0, y: 0, width: size.width, height: y + padding)
    }

    func clampPosition() {
        guard !NSScreen.screens.contains(where: { $0.visibleFrame.contains(panel.frame) }),
              let screen = NSScreen.main else { return }
        var frame = panel.frame
        frame.origin.x = min(max(frame.minX, screen.visibleFrame.minX), screen.visibleFrame.maxX - frame.width)
        frame.origin.y = min(max(frame.minY, screen.visibleFrame.minY), screen.visibleFrame.maxY - frame.height)
        panel.setFrame(frame, display: false)
    }

    func save() {
        config["bounds"] = [panel.frame.minX, panel.frame.minY, panel.frame.width]
        config["visible"] = panel.isVisible
        config["alwaysOnTop"] = panel.isFloatingPanel
        do { try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]).write(to: configURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
        } catch { showNotice("Could not save preferences") }
    }
    func windowDidResize(_ notification: Notification) { layout(); save() }
    func windowDidMove(_ notification: Notification) { save() }
    func windowWillClose(_ notification: Notification) { visibleActions = false; refreshActionHotkeys() }
    func windowDidChangeScreen(_ notification: Notification) { clampPosition() }
    @objc func toggleAlwaysOnTop(_ sender: NSMenuItem) {
        panel.isFloatingPanel.toggle()
        panel.level = panel.isFloatingPanel ? .floating : .normal
        sender.state = panel.isFloatingPanel ? .on : .off
        save()
    }
    @objc func toggle() {
        if panel.isVisible { panel.orderOut(nil); save() }
        else { clampPosition(); panel.orderFrontRegardless(); save() }
        refreshActionHotkeys()
    }
    @objc func clicked(_ button: NSButton) { action(button.tag + 1) }
    @objc func openQueue() { action(19) }

    func showNotice(_ text: String) {
        guard notice.stringValue != text else { return }
        notice.stringValue = text
        notice.toolTip = text
        notice.isHidden = text.isEmpty
        if !text.isEmpty {
            NSAccessibility.post(element: panel!, notification: .announcementRequested,
                userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
    }

    func refreshPendingButtons() {
        renderButtons(displayedState(snapshot, commands))
        queueButton.isEnabled = Date().timeIntervalSince(lastSync) <= 4 &&
            !(snapshot["account"] as? String ?? "").isEmpty
        let actions = Set(commands.map { $0["action"] as? String ?? "" })
        let supported = Date().timeIntervalSince(lastSync) <= 4 && snapshot["supported"] as? Bool == true &&
            !(snapshot["account"] as? String ?? "").isEmpty
        for (index, button) in buttons.enumerated() {
            let pending = index < 2 ? !actions.isDisjoint(with: ["like", "love"]) :
                actions.contains("add")
            button.setAccessibilityHelp(pending ? "\(button.toolTip ?? "") · Updating Spotify" : button.toolTip)
            let available = index < 2 ? snapshot[index == 0 ? "loved" : "liked"] as? Bool != nil :
                true
            button.isEnabled = supported && available
        }
    }

    func renderButtons(_ state: [String: Any]) {
        let supported = state["supported"] as? Bool == true && !(state["account"] as? String ?? "").isEmpty
        for (index, key) in ["loved", "liked"].enumerated() {
            let value = state[key] as? Bool
            buttons[index].isEnabled = supported && value != nil
            let symbol = index == 0 ? "heart" : "star"
            buttons[index].image = NSImage(systemSymbolName: symbol + (value == true ? ".fill" : ""), accessibilityDescription: index == 0 ? "Love" : "Like")
            buttons[index].contentTintColor = value == true ? (index == 0 ? .systemRed : .systemYellow) : .white
            let accessibilityValue = value == true ? "On" : "Off"
            let changed = buttons[index].accessibilityValue() as? String != accessibilityValue
            buttons[index].setAccessibilityValue(accessibilityValue)
            if changed { NSAccessibility.post(element: buttons[index], notification: .valueChanged) }
        }
        buttons[2].isEnabled = supported
        buttons[0].toolTip = "Love — \(shortcutLabel(keys[1]))"
        buttons[1].toolTip = "Like — \(shortcutLabel(keys[2]))"
        buttons[2].toolTip = "Add to playlists — \(shortcutLabel(keys[3]))"
    }

    func update(_ incoming: [String: Any]) {
        var state = incoming
        if snapshot["account"] as? String == state["account"] as? String && snapshot["uri"] as? String == state["uri"] as? String {
            for key in ["loved", "liked", "added"] where state[key] as? Bool == nil {
                state[key] = snapshot[key] as? Bool
            }
        }
        let accountChanged = snapshot["account"] as? String != state["account"] as? String
        if accountChanged { commands.removeAll(); showNotice("") }
        if accountChanged || snapshot["uri"] as? String != state["uri"] as? String {
            showNotice("")
            buttons.forEach { $0.layer?.removeAllAnimations() }
        }
        snapshot = state
        lastSync = Date()
        let remaining = state["queueCount"] as? Int
        queueBadge.string = remaining.map { String($0) } ?? ""
        queueBadge.isHidden = (remaining ?? 0) <= 0
        queueButton.toolTip = remaining.map { "Queue — \($0) \($0 == 1 ? "track" : "tracks") remaining" } ?? "Queue"
        queueButton.setAccessibilityHelp(queueButton.toolTip)
        layout()
        for (label, key) in [(title, "title"), (artist, "artist"), (album, "album")] {
            label.stringValue = state[key] as? String ?? "Unavailable"
            label.toolTip = label.stringValue
        }
        refreshPendingButtons()
        if notice.stringValue.hasPrefix("Spotify disconnected") || notice.stringValue.hasPrefix("Connecting") {
            showNotice("")
        }
        let url = state["image"] as? String ?? ""
        if url != imageURL {
            imageURL = url
            imageTask?.cancel()
            artwork.image = nil
            if let remote = URL(string: url), remote.scheme == "https", remote.host?.hasSuffix(".scdn.co") == true {
                imageTask = URLSession.shared.dataTask(with: remote) { [weak self] data, _, _ in
                    guard let data, data.count < 15_000_000, let image = NSImage(data: data) else { return }
                    DispatchQueue.main.async { if self?.imageURL == url { self?.artwork.image = image } }
                }
                imageTask?.resume()
            }
        }
        refreshActionHotkeys()
    }

    func action(_ id: Int) {
        if id == 0 { toggle(); return }
        if id == 18 || id == 19 {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").first?.activate(options: [])
            if Date().timeIntervalSince(lastSync) <= 4 { queueAction(id) }
            return
        }
        guard [1, 2, 3, 13, 14, 15, 16, 17].contains(id) else { return }
        guard panel.isVisible, Date().timeIntervalSince(lastSync) <= 4,
              snapshot["supported"] as? Bool == true else { showNotice("Play a track in Spotify first"); return }
        let pending = commands.contains { command in
            let action = command["action"] as? String
            if id <= 2 { return action == "like" || action == "love" }
            if id == 3 { return action == "add" }
            if id == 13 { return action == "remove" || action == "undo" }
            return false
        }
        guard id <= 2 || !pending else { return }
        if id <= 2 && !buttons[id - 1].isEnabled { showNotice("Track state is still loading"); return }
        if id == 13 && (snapshot["removal"] as? [String: Any])?["enabled"] as? Bool != true {
            showNotice((snapshot["removal"] as? [String: Any])?["reason"] as? String ?? "Remove unavailable"); return
        }
        if id == 3 {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").first?.activate(options: [])
        }
        queueAction(id)
    }

    func queueAction(_ id: Int) {
        let removal = snapshot["removal"] as? [String: Any] ?? [:]
        let names = [1: "love", 2: "like", 3: "add", 14: "previous", 15: "next", 16: "seek-back", 17: "seek-forward", 18: "keys", 19: "queue", 20: "shuffle", 21: "randomize"]
        var command: [String: Any] = ["id": UUID().uuidString, "action": names[id] ?? (removal["action"] as? String ?? "remove"),
            "removal": removal,
            "uri": snapshot["uri"] as? String ?? "", "account": snapshot["account"] as? String ?? "",
            "expires": Date().timeIntervalSince1970 * 1000 + 5000]
        if id <= 2 {
            let current = displayedState(snapshot, commands)
            command["value"] = !(current[id == 1 ? "loved" : "liked"] as? Bool ?? false)
        }
        if id == 20 { command["value"] = !(snapshot["shuffle"] as? Bool ?? false) }
        commands.append(command)
        showNotice("")
        refreshPendingButtons()
    }

    func shortcutLabel(_ key: String) -> String {
        [(controlKey, "⌃"), (optionKey, "⌥"), (shiftKey, "⇧"), (cmdKey, "⌘")]
            .filter { modifiers & UInt32($0.0) != 0 }.map { $0.1 }.joined() + key.uppercased()
    }

    func installHotkeyHandler() {
        var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                     EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, pointer in
            guard let event, let pointer else { return OSStatus(eventNotHandledErr) }
            let app = Unmanaged<Mini>.fromOpaque(pointer).takeUnretainedValue()
            app.hotkeyEvents += 1
            var key = EventHotKeyID()
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                nil, MemoryLayout<EventHotKeyID>.size, nil, &key) == noErr else { return OSStatus(eventNotHandledErr) }
            if GetEventKind(event) == UInt32(kEventHotKeyReleased) { app.pressed.remove(key.id) }
            else if app.pressed.insert(key.id).inserted { app.action(Int(key.id)) }
            return noErr
        }, types.count, &types, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
        if status != noErr { showNotice("Could not install shortcut handler (\(status))") }
    }

    func register(_ id: UInt32, _ key: String, code: UInt32? = nil, extra: UInt32 = 0) -> Bool {
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(code ?? keyCodes[key]!, modifiers | extra,
            EventHotKeyID(signature: 0x4A53484D, id: id), GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            showNotice("Shortcut \(shortcutLabel(key)) unavailable (\(status))")
            return false
        }
        shortcuts[id] = ref
        return true
    }
    func registerToggle() {
        _ = register(0, keys[0])
        _ = register(18, "/", code: UInt32(kVK_ANSI_Slash))
    }
    func refreshActionHotkeys() {
        let enabled = panel.isVisible && Date().timeIntervalSince(lastSync) <= 4 && snapshot["supported"] as? Bool == true
        guard enabled != visibleActions else { return }
        visibleActions = enabled
        for (id, ref) in shortcuts where id != 0 && id != 18 { UnregisterEventHotKey(ref); shortcuts.removeValue(forKey: id) }
        pressed.formIntersection([0, 18])
        if enabled {
            for (index, key) in Array(keys.dropFirst().prefix(3)).enumerated() { _ = register(UInt32(index + 1), key) }
            _ = register(13, keys[4])
            _ = register(14, "←", code: UInt32(kVK_LeftArrow))
            _ = register(15, "→", code: UInt32(kVK_RightArrow))
            _ = register(16, "<", code: UInt32(kVK_ANSI_Comma))
            _ = register(17, ">", code: UInt32(kVK_ANSI_Period))
        }
    }

    func receive(_ connection: NWConnection) {
        connection.start(queue: .main)
        var buffer = Data()
        let deadline = DispatchWorkItem { connection.cancel() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
        func read() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
                if let data { buffer.append(data) }
                do {
                    if let request = try Request.parse(buffer) {
                        deadline.cancel()
                        self?.respond(connection, request)
                    } else if complete || error != nil { deadline.cancel(); connection.cancel() }
                    else { read() }
                } catch { deadline.cancel(); connection.cancel() }
            }
        }
        read()
    }

    func complete(_ results: [[String: Any]]) {
        for result in results {
            if let id = result["id"] as? String, let command = commands.first(where: { $0["id"] as? String == id }) {
                commands.removeAll { $0["id"] as? String == id }
                musicResults.append(result)
                if musicResults.count > 128 { musicResults.removeFirst() }
                let action = command["action"] as? String ?? ""
                let removal = command["removal"] as? [String: Any] ?? [:]
                let currentRemoval = snapshot["removal"] as? [String: Any] ?? [:]
                let currentEntry = !["remove", "undo"].contains(action) ||
                    ["context", "itemUid", "provider"].allSatisfy { removal[$0] as? String == currentRemoval[$0] as? String }
                if command["uri"] as? String == snapshot["uri"] as? String && currentEntry {
                    if result["ok"] as? Bool == true {
                        showNotice("")
                    } else {
                        showNotice(result["message"] as? String ?? "Could not complete action")
                    }
                }
            }
        }
        refreshPendingButtons()
    }

    func musicResponse(_ request: Request) -> (Int, [String: Any]) {
        let connected = Date().timeIntervalSince(lastSync) <= 4
        let busy = commands.contains { ["love", "like", "add", "seek-forward", "queue-toggle", "shuffle", "randomize", "playlist"].contains($0["action"] as? String ?? "") }
        if request.method == "GET" {
            let state = displayedState(snapshot, commands).filter { ["uri", "account", "supported", "loved", "liked", "added", "shuffle", "playlistSelector", "position", "duration", "canSeek"].contains($0.key) }
            return (200, ["connected": connected, "busy": busy, "state": state, "results": musicResults])
        }
        guard request.method == "POST" else { return (405, [:]) }
        guard let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let uri = json["uri"] as? String, let account = json["account"] as? String,
              let action = json["action"] as? String,
              let id = ["love": 1, "like": 2, "add": 3, "seek-forward": 17, "queue-toggle": 19, "shuffle": 20, "randomize": 21, "playlist": 22][action] else { return (400, [:]) }
        guard connected, !account.isEmpty,
              [19, 20, 21].contains(id) || (snapshot["supported"] as? Bool == true && uri.hasPrefix("spotify:track:")) else {
            return (503, ["message": "Play a track in Spotify first"])
        }
        guard ([19, 20, 21].contains(id) || uri == snapshot["uri"] as? String), account == snapshot["account"] as? String,
              !busy else { return (409, ["message": "Track or action state changed; try again"]) }
        if id <= 2 {
            let key = id == 1 ? "loved" : "liked"
            guard let value = json[key] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else { return (400, [:]) }
            guard let current = snapshot[key] as? Bool else { return (503, [:]) }
            guard value.boolValue == current else { return (409, [:]) }
        } else if id == 20 {
            guard let value = json["shuffle"] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else { return (400, [:]) }
            guard let current = snapshot["shuffle"] as? Bool else { return (503, [:]) }
            guard value.boolValue == current else { return (409, [:]) }
        } else if id == 22 {
            guard let playlist = json["playlist"] as? String, playlist.range(of: "^spotify:playlist:[a-zA-Z0-9]+$", options: .regularExpression) != nil,
                  let saved = json["saved"] as? NSNumber, CFGetTypeID(saved) == CFBooleanGetTypeID() else { return (400, [:]) }
            guard let selector = snapshot["playlistSelector"] as? [String: Any], selector["ready"] as? Bool == true,
                  let playlists = selector["playlists"] as? [[String: Any]],
                  let selected = playlists.first(where: { $0["uri"] as? String == playlist }),
                  selected["saved"] as? Bool == saved.boolValue else { return (409, [:]) }
            let command: [String: Any] = ["id": UUID().uuidString, "action": action, "uri": uri, "account": account,
                "playlist": playlist, "saved": saved.boolValue, "expires": Date().timeIntervalSince1970 * 1000 + 15000]
            commands.append(command)
            return (202, ["id": command["id"]!])
        } else if id == 3 || id == 19 {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").first?.activate(options: [])
        }
        // Stream Deck uses the same queue even while the panel is hidden.
        queueAction(id)
        if id == 19 { commands[commands.count - 1]["action"] = "queue-toggle" }
        return (202, ["id": commands.last!["id"]!])
    }

    func seekResponse(_ request: Request) -> (Int, [String: Any]) {
        guard request.method == "POST" else { return (405, [:]) }
        guard let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let uri = json["uri"] as? String, let account = json["account"] as? String,
              let position = json["position"] as? NSNumber, CFGetTypeID(position) != CFBooleanGetTypeID(),
              position.doubleValue.isFinite, position.doubleValue >= 0 else { return (400, [:]) }
        guard Date().timeIntervalSince(lastSync) <= 4, snapshot["supported"] as? Bool == true,
              snapshot["canSeek"] as? Bool == true else { return (503, [:]) }
        guard !account.isEmpty, account == snapshot["account"] as? String,
              uri == snapshot["uri"] as? String,
              let duration = snapshot["duration"] as? Double, duration.isFinite,
              duration > 0, position.doubleValue < duration else { return (409, [:]) }
        // Only the latest absolute target is needed while Spotify reconnects.
        pendingSeek = ["id": UUID().uuidString, "action": "seek", "uri": uri, "account": account,
                       "position": position.doubleValue, "expires": Date().timeIntervalSince1970 * 1000 + 2000]
        seekReply?()
        return (202, [:])
    }

    func takeSeek() -> [[String: Any]] {
        defer { pendingSeek = nil }
        guard let command = pendingSeek,
              Date().timeIntervalSince(lastSync) <= 4, snapshot["canSeek"] as? Bool == true,
              (command["expires"] as? Double ?? 0) >= Date().timeIntervalSince1970 * 1000,
              command["uri"] as? String == snapshot["uri"] as? String,
              command["account"] as? String == snapshot["account"] as? String else { return [] }
        return [command]
    }

    func respond(_ connection: NWConnection, _ request: Request) {
        let origin = request.headers["origin"]
        let allowedOrigin = origin == nil || origins.contains(origin!)
        let authenticated = request.headers["authorization"] == "Bearer \(token)"
        var status = 200
        var payload: [String: Any] = [:]
        if !allowedOrigin { status = 403 }
        else if request.path == "/seek" {
            if request.method == "OPTIONS" { status = 204 }
            else if !authenticated { status = 401 }
            else if request.method == "GET" {
                seekReply?()
                seekTimeout?.cancel()
                seekReply = { [weak self] in
                    guard let self else { connection.cancel(); return }
                    self.seekTimeout?.cancel()
                    self.seekReply = nil
                    self.sendResponse(connection, origin: origin, status: 200, payload: ["commands": self.takeSeek()])
                }
                if pendingSeek != nil { seekReply?() }
                else {
                    let timeout = DispatchWorkItem { [weak self] in self?.seekReply?() }
                    seekTimeout = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: timeout)
                }
                return
            } else { (status, payload) = seekResponse(request) }
        }
        else if request.path == "/love" {
            if !authenticated { status = 401 }
            else { (status, payload) = musicResponse(request) }
        }
        else if request.path == "/status" && request.method == "GET" && authenticated {
            payload = ["visible": panel.isVisible, "hotkeys": shortcuts.keys.sorted(),
                "handlerInstalled": eventHandler != nil, "hotkeyEvents": hotkeyEvents,
                "onActiveSpace": panel.isOnActiveSpace,
                "occluded": !panel.occlusionState.contains(.visible),
                "connected": Date().timeIntervalSince(lastSync) <= 4,
                "bounds": [panel.frame.minX, panel.frame.minY, panel.frame.width, panel.frame.height],
                "title": title.stringValue, "notice": notice.stringValue]
        }
        else if request.path != "/sync" { status = 404 }
        else if request.method == "OPTIONS" { status = 204 }
        else if request.method != "POST" { status = 405 }
        else if !authenticated { status = 401 }
        else if let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let state = json["state"] as? [String: Any],
                let account = state["account"] as? String, !account.isEmpty {
            update(state)
            complete(json["results"] as? [[String: Any]] ?? [])
            payload = ["commands": commands, "shortcuts": ["modifiers": shortcutLabel(""), "keys": keys]]
        } else { status = 400 }
        sendResponse(connection, origin: allowedOrigin ? origin : nil, status: status, payload: payload)
    }

    func sendResponse(_ connection: NWConnection, origin: String?, status: Int, payload: [String: Any]) {
        let body = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        var headers = "HTTP/1.1 \(status) Response\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n"
        if let origin {
            headers += "Access-Control-Allow-Origin: \(origin)\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n"
        }
        connection.send(content: Data((headers + "\r\n").utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }

    func applicationWillTerminate(_ notification: Notification) {
        seekTimeout?.cancel(); seekReply?()
        save(); listener?.cancel(); imageTask?.cancel()
        for ref in shortcuts.values { UnregisterEventHotKey(ref) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }
}

if CommandLine.arguments.dropFirst().first == "--validate-config" {
    do {
        guard CommandLine.arguments.count == 3 else { throw MiniError.invalidConfig }
        _ = try loadConfig(URL(fileURLWithPath: CommandLine.arguments[2]))
    } catch { fputs("Mini Player config invalid: \(error)\n", stderr); exit(1) }
} else if CommandLine.arguments.contains("--self-test") || CommandLine.arguments.contains("--ui-self-test") {
    let initial: [String: Any] = ["uri": "spotify:track:one", "account": "one", "supported": true, "loved": false, "liked": false]
    let command: [String: Any] = ["id": "test", "uri": initial["uri"]!, "account": initial["account"]!, "action": "love", "value": true]
    let optimistic = displayedState(initial, [command])
    assert(optimistic["loved"] as? Bool == true && optimistic["liked"] as? Bool == true)
    assert(displayedState(initial, [])["loved"] as? Bool == false)
    var selectedState = optimistic
    let unlike: [String: Any] = ["uri": initial["uri"]!, "account": initial["account"]!, "action": "like", "value": false]
    selectedState = displayedState(selectedState, [unlike])
    assert(selectedState["liked"] as? Bool == false && selectedState["loved"] as? Bool == false)
    var removalState = initial
    removalState["removal"] = ["context": "playlist", "itemUid": "entry", "provider": "context", "action": "remove", "enabled": true]
    let remove: [String: Any] = ["uri": initial["uri"]!, "account": initial["account"]!, "action": "remove", "removal": removalState["removal"]!]
    assert((displayedState(removalState, [remove])["removal"] as? [String: Any])?["action"] as? String == "undo")
    removalState["removal"] = ["context": "playlist", "itemUid": "other", "provider": "context", "action": "remove", "enabled": true]
    assert((displayedState(removalState, [remove])["removal"] as? [String: Any])?["action"] as? String == "remove")
    var changed = initial
    changed["uri"] = "spotify:track:two"
    assert(displayedState(changed, [command])["loved"] as? Bool == false)
    changed = initial
    changed["account"] = "two"
    assert(displayedState(changed, [command])["loved"] as? Bool == false)
    if CommandLine.arguments.contains("--ui-self-test") {
        _ = NSApplication.shared
        let testConfig = FileManager.default.temporaryDirectory.appendingPathComponent("mini-feedback-\(UUID().uuidString).json")
        try! JSONSerialization.data(withJSONObject: ["token": String(repeating: "a", count: 64), "port": 47684]).write(to: testConfig)
        defer { try? FileManager.default.removeItem(at: testConfig) }
        let mini = try! Mini(configURL: testConfig)
        mini.makePanel()
        func loveRequest(_ body: [String: Any], method: String = "POST") -> Request {
            Request(method: method, path: "/love", headers: [:], body: try! JSONSerialization.data(withJSONObject: body))
        }
        mini.update(initial)
        let loveBody: [String: Any] = ["action": "love", "uri": "spotify:track:one", "account": "one", "loved": false]
        assert(!mini.panel.isVisible)
        assert(mini.musicResponse(loveRequest(loveBody)).0 == 202, "Stream Deck Love must work with a hidden panel")
        let loveID = mini.commands.last!["id"] as! String
        assert(mini.commands.last!["value"] as? Bool == true)
        assert(mini.musicResponse(loveRequest(loveBody)).0 == 409, "pending writes must reject duplicate presses")
        mini.complete([["id": loveID, "ok": false, "message": "Failed"]])
        assert(mini.musicResults.last?["ok"] as? Bool == false)
        let resultCount = mini.musicResults.count
        mini.complete([["id": loveID, "ok": true]])
        assert(mini.musicResults.count == resultCount, "duplicate acknowledgements must not replace a failure")
        assert(mini.musicResponse(loveRequest(loveBody.merging(["uri": "spotify:track:two"]) { _, new in new })).0 == 409)
        assert(mini.musicResponse(loveRequest(loveBody.merging(["account": "two"]) { _, new in new })).0 == 409)
        assert(mini.musicResponse(loveRequest(loveBody.merging(["loved": true]) { _, new in new })).0 == 409)
        assert(mini.musicResponse(loveRequest([:])).0 == 400)
        assert(mini.musicResponse(loveRequest(loveBody.merging(["loved": 0]) { _, new in new })).0 == 400)
        assert(mini.musicResponse(loveRequest([:], method: "DELETE")).0 == 405)
        mini.lastSync = .distantPast
        assert(mini.musicResponse(loveRequest(loveBody)).0 == 503)
        assert(mini.musicResponse(loveRequest([:], method: "GET")).1["connected"] as? Bool == false)
        mini.update(initial.merging(["supported": false]) { _, new in new })
        assert(mini.musicResponse(loveRequest(loveBody)).0 == 503)
        mini.snapshot = [:]
        mini.update(initial.merging(["loved": NSNull()]) { _, new in new })
        assert(mini.musicResponse(loveRequest(loveBody)).0 == 503)
        mini.update(initial)
        let content = mini.panel.contentView!
        let menu = content.menu!
        assert(menu.items.map(\.title) == ["Hide Mini Player", "Always on Top"])
        let rightClick = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: mini.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        assert(([content] + content.subviews).allSatisfy { $0.menu(for: rightClick) === menu })
        let onTop = menu.items[1]
        assert(mini.panel.level == .floating && onTop.state == .on)
        assert(NSApp.sendAction(onTop.action!, to: onTop.target, from: onTop))
        assert(mini.panel.level == .normal && !mini.panel.isFloatingPanel && onTop.state == .off)
        let restored = try! Mini(configURL: testConfig)
        restored.makePanel()
        assert(restored.panel.level == .normal && restored.panel.contentView!.menu!.items[1].state == .off)
        assert(NSApp.sendAction(onTop.action!, to: onTop.target, from: onTop))
        assert(mini.panel.level == .floating && onTop.state == .on)
        mini.panel.orderFrontRegardless()
        assert(mini.panel.isVisible)
        let hide = menu.items[0]
        assert(NSApp.sendAction(hide.action!, to: hide.target, from: hide))
        assert(!mini.panel.isVisible && mini.config["visible"] as? Bool == false)
        for width in stride(from: 140.0, through: 640.0, by: 20) {
            mini.panel.setFrame(NSRect(x: 100, y: 100, width: width, height: width), display: false)
            mini.layout()
            assert(mini.panel.frame.width == width)
            let controls: [NSView] = mini.buttons + [mini.queueButton, mini.notice, mini.album, mini.artist, mini.title]
            assert(controls.allSatisfy { content.bounds.contains($0.frame) })
            for (index, control) in controls.enumerated() {
                assert(controls.dropFirst(index + 1).allSatisfy { !control.frame.intersects($0.frame) })
            }
            assert([mini.notice, mini.album, mini.artist].allSatisfy { $0.font!.pointSize >= 12 })
            assert(mini.title.font!.pointSize >= 14)
        }
        mini.panel.setFrame(NSRect(x: 100, y: 100, width: 140, height: 140), display: false)
        mini.save()
        let compact = try! Mini(configURL: testConfig)
        compact.makePanel()
        assert(compact.panel.frame.width == 140)
        mini.panel.setFrame(NSRect(x: 100, y: 100, width: 320, height: 320), display: false)
        mini.layout()
        assert(mini.title.font!.pointSize == 19 && mini.artist.font!.pointSize == 14)
        mini.update(initial)
        mini.update(initial.merging(["queueCount": 60]) { _, new in new })
        assert(mini.queueBadge.string as? String == "60" && !mini.queueBadge.isHidden)
        assert(mini.queueButton.isEnabled && mini.queueButton.accessibilityLabel() == "Queue")
        assert(mini.buttons.map { $0.accessibilityLabel() } == ["Love", "Like", "Add to playlists"])
        for width in [140.0, 320.0, 640.0] {
            mini.panel.setFrame(NSRect(x: 100, y: 100, width: width, height: width), display: false)
            mini.layout()
            assert(content.bounds.contains(mini.queueButton.frame))
            assert(mini.queueButton.frame.minX > mini.buttons.last!.frame.maxX)
            assert(mini.queueButton.frame.minY == mini.buttons.last!.frame.minY)
            assert(!mini.queueButton.frame.intersects(mini.title.frame))
            assert(mini.queueButton.bounds.contains(mini.queueBadge.frame))
        }
        mini.update(initial)
        assert(mini.queueBadge.isHidden && mini.queueButton.isEnabled)
        mini.update(initial.merging(["queueCount": 0]) { _, new in new })
        assert(mini.queueBadge.isHidden)
        mini.update(initial.merging(["queueCount": 123]) { _, new in new })
        assert(mini.queueBadge.string as? String == "123" && !mini.queueBadge.isHidden)
        assert(mini.queueButton.bounds.contains(mini.queueBadge.frame))
        mini.lastSync = .distantPast
        mini.refreshPendingButtons()
        assert(!mini.queueButton.isEnabled)
        mini.update(initial)
        mini.panel.setFrame(NSRect(x: 100, y: 100, width: 320, height: 320), display: false)
        mini.layout()
        assert(mini.buttons.allSatisfy { $0.focusRingType == .none })
        mini.panel.makeFirstResponder(mini.buttons[0])
        assert(mini.buttons[0].layer?.borderWidth == 0, "initial or pointer focus must not outline the icon")
        mini.buttons[0].keyboardFocused = true
        assert(mini.buttons[0].layer?.borderWidth == 1.5)
        mini.buttons[2].isEnabled = false
        mini.buttons[2].mouseDown(with: NSEvent())
        assert(mini.buttons[0].layer?.borderWidth == 0, "pointer interaction must clear the keyboard-only outline")
        mini.buttons[2].isEnabled = true
        mini.buttons[0].mouseEntered(with: NSEvent())
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let layer = mini.buttons[0].layer!
            let transform = layer.transform
            assert(abs(transform.m11 - 1.1) < 0.001)
            let center = CGPoint(x: layer.bounds.width * (0.5 - layer.anchorPoint.x),
                                 y: layer.bounds.height * (0.5 - layer.anchorPoint.y))
            assert(abs(center.x * transform.m11 + transform.m41 - center.x) < 0.001)
            assert(abs(center.y * transform.m22 + transform.m42 - center.y) < 0.001)
        }
        mini.buttons[0].mouseExited(with: NSEvent())
        assert(mini.buttons[0].layer!.transform.m11 == 1)
        assert(mini.buttons[0].isEnabled && mini.buttons[1].isEnabled)
        assert(mini.buttons[0].acceptsFirstMouse(for: nil))
        mini.queueAction(15)
        mini.queueAction(14)
        mini.queueAction(16)
        mini.queueAction(17)
        mini.queueAction(18)
        mini.queueAction(19)
        assert(mini.commands.map { $0["action"] as? String } == ["next", "previous", "seek-back", "seek-forward", "keys", "queue"])
        mini.commands.removeAll()
        mini.panel.orderFrontRegardless()
        mini.update(initial.merging(["removal": ["enabled": false]]) { _, new in new })
        mini.action(13)
        assert(mini.commands.isEmpty, "Remove shortcut must still reject unavailable removals without a Delete button")
        mini.update(initial.merging(["removal": ["enabled": true, "action": "remove"]]) { _, new in new })
        mini.action(13)
        assert(mini.commands.last?["action"] as? String == "remove")
        mini.commands.removeAll()
        mini.panel.orderOut(nil)
        mini.update(initial)
        mini.showNotice("")
        mini.queueAction(1)
        mini.queueAction(2)
        assert(mini.commands.count == 2 && mini.buttons[0].accessibilityValue() as? String == "Off" && mini.buttons[1].accessibilityValue() as? String == "Off", "rapid Unlike must immediately clear both pending fills")
        mini.queueAction(1)
        assert(mini.commands.count == 3 && mini.buttons[0].accessibilityValue() as? String == "On" && mini.buttons[1].accessibilityValue() as? String == "On", "the next click must immediately restore both fills")
        mini.update(initial)
        assert(mini.buttons[0].accessibilityValue() as? String == "On", "older sync must preserve the latest click")
        mini.commands.removeAll()
        mini.refreshPendingButtons()
        var selected = initial
        selected["loved"] = true
        selected["liked"] = true
        mini.update(selected)
        let heartImage = mini.buttons[0].image
        let heartTint = mini.buttons[0].contentTintColor
        selected["loved"] = NSNull()
        selected["liked"] = NSNull()
        mini.update(selected)
        assert(mini.snapshot["loved"] as? Bool == true && mini.snapshot["liked"] as? Bool == true)
        assert(mini.buttons[0].image?.name() == heartImage?.name() && mini.buttons[0].contentTintColor == heartTint)
        mini.buttons[0].hovered = true
        assert(mini.buttons[0].layer?.borderWidth == 0)
        assert((mini.buttons[0].cell as! NSButtonCell).highlightsBy.isEmpty)
        mini.update(initial)
        mini.commands = [command]
        mini.refreshPendingButtons()
        assert(mini.buttons[0].accessibilityHelp()?.contains("Updating Spotify") == true && mini.buttons[1].accessibilityHelp()?.contains("Updating Spotify") == true)
        assert(mini.buttons[0].isEnabled && mini.buttons[0].alphaValue == 1 && mini.buttons[0].contentTintColor == heartTint)
        assert(mini.buttons[0].layer?.borderWidth == 0)
        assert(mini.buttons[0].accessibilityValue() as? String == "On")
        assert(mini.buttons[1].accessibilityValue() as? String == "On")
        mini.update(initial)
        assert(mini.buttons[0].accessibilityValue() as? String == "On", "old sync must not overwrite the immediate toggle")
        mini.complete([["id": "test", "ok": false, "message": "Could not update Love"]])
        assert(mini.notice.stringValue == "Could not update Love" && !mini.notice.drawsBackground)
        assert(mini.notice.frame.minY > mini.buttons[0].frame.maxY && mini.buttons[0].isEnabled && mini.buttons[0].alphaValue == 1)
        assert(mini.buttons[0].accessibilityHelp()?.contains("Updating Spotify") == false && mini.buttons[0].layer?.borderWidth == 0)
        assert(mini.buttons[0].accessibilityValue() as? String == "Off", "failed command must restore confirmed state")
        var partial = initial
        partial["liked"] = true
        mini.update(partial)
        mini.commands = [command]
        mini.refreshPendingButtons()
        mini.complete([["id": "test", "ok": false]])
        assert(mini.buttons[0].accessibilityValue() as? String == "Off" && mini.buttons[1].accessibilityValue() as? String == "On", "partial Love failure must keep the confirmed Like")
        var confirmed = initial
        confirmed["loved"] = true
        confirmed["liked"] = true
        mini.update(confirmed)
        mini.commands = [command]
        mini.complete([["id": "test", "ok": true, "message": "Added to Loved Songs"]])
        assert(mini.notice.stringValue.isEmpty && mini.notice.isHidden)
        mini.showNotice("Newer failure")
        mini.complete([["id": "test", "ok": true]])
        assert(mini.notice.stringValue == "Newer failure", "repeated acknowledgement must not replay feedback")
        mini.commands = [command]
        changed = initial
        changed["uri"] = "spotify:track:two"
        mini.update(changed)
        mini.complete([["id": "test", "ok": false, "message": "Old track failure"]])
        assert(mini.notice.stringValue.isEmpty, "late feedback must not affect the new track")
    }
    let body = Data("{}".utf8)
    let packet = Data("POST /sync HTTP/1.1\r\nContent-Length: 2\r\n\r\n".utf8) + body
    let parsed = try! Request.parse(packet)
    let incomplete = try! Request.parse(packet.dropLast())
    assert(parsed?.body == body)
    assert(incomplete == nil)
    for header in ["Content-Length: -1", "Content-Length: 999999", "Content-Length: 0\r\nContent-Length: 0", "Transfer-Encoding: chunked"] {
        do { _ = try Request.parse(Data("POST /sync HTTP/1.1\r\n\(header)\r\n\r\n".utf8)); fatalError("Accepted unsafe HTTP request") }
        catch {}
    }
    assert(validKeys(["m", "h", "l", "p", "r"], modifiers: UInt32(cmdKey | optionKey | controlKey)))
    assert(!validKeys(["m", "m", "l", "p", "r"], modifiers: UInt32(cmdKey)))
    assert(!validKeys(["1", "h", "l", "p", "r"], modifiers: UInt32(cmdKey)))
    assert(validKeys(["[", "]", "-", "=", "\\"], modifiers: UInt32(cmdKey | optionKey | controlKey)))
    assert(!validKeys(["[", "[", "-", "=", "\\"], modifiers: UInt32(cmdKey)))
    assert(!validKeys(["[", "]", "-", "=", "\\"], modifiers: UInt32(shiftKey)))
    assert(["[", "]", "-", "=", "\\"].map { keyCodes[$0]! } == [UInt32(kVK_ANSI_LeftBracket), UInt32(kVK_ANSI_RightBracket), UInt32(kVK_ANSI_Minus), UInt32(kVK_ANSI_Equal), UInt32(kVK_ANSI_Backslash)])
    assert(migratedKeys(["m", "h", "l", "p"]) == ["m", "h", "l", "p", "r"])
    assert(migratedKeys(["m", "r", "l", "p"]) == ["m", "r", "l", "p", "u"])
    assert(!validKeys(["m", "h", "l", "p"], modifiers: UInt32(cmdKey)))
    print("Mini Player request, shortcut and button feedback checks passed")
} else {
    guard let path = CommandLine.arguments.dropFirst().first else { fatalError("Pass the private config file") }
    do {
        let app = NSApplication.shared
        let delegate = try Mini(configURL: URL(fileURLWithPath: path))
        app.delegate = delegate
        app.run()
    } catch { fputs("Mini Player config invalid: \(error)\n", stderr); exit(1) }
}
