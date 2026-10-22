import Foundation
import Security

/// Where the pairing can be kept so that both the app and the widget extension
/// can read it. Which of these survive free-Apple-ID re-signing (Sideloadly) is
/// exactly what the phase-2 diagnostic build measures, so every channel is
/// written and read independently and reports its own result.
enum PairingChannel: String, CaseIterable, Identifiable {
    case appGroup = "App 组"
    case sharedKeychain = "共享钥匙串"
    case appLocal = "仅本进程"

    var id: String { rawValue }
}

struct ChannelReport: Identifiable {
    let channel: PairingChannel
    let ok: Bool
    let detail: String
    var id: String { channel.rawValue }
}

enum PairingStore {
    static let appGroupID = "group.com.adrian0925.tokentracker"
    static let sharedKeychainSuffix = "com.adrian0925.tokentracker.shared"
    private static let keychainService = "com.adrian0925.tokentracker.pairing"
    private static let keychainAccount = "gateway"
    private static let defaultsKey = "gatewayPairing"

    // MARK: Environment probes

    static var appGroupContainerAvailable: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID) != nil
    }

    /// The team prefix ("ABCDE12345") this binary was signed with, discovered by
    /// writing a probe item to the default keychain group and reading back the
    /// access group the system assigned to it ("ABCDE12345.<bundle id>").
    static func appIdentifierPrefix() -> String? {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(keychainService).probe",
            kSecAttrAccount as String: "probe",
        ]
        SecItemDelete(probe as CFDictionary)
        var add = probe
        add[kSecValueData as String] = Data([1])
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        add[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        let status = SecItemAdd(add as CFDictionary, &result)
        SecItemDelete(probe as CFDictionary)
        guard status == errSecSuccess,
              let attributes = result as? [String: Any],
              let group = attributes[kSecAttrAccessGroup as String] as? String,
              let dot = group.firstIndex(of: ".")
        else { return nil }
        return String(group[..<dot])
    }

    static var sharedKeychainGroup: String? {
        appIdentifierPrefix().map { "\($0).\(sharedKeychainSuffix)" }
    }

    // MARK: Save / load

    @discardableResult
    static func save(_ pairing: GatewayPairing) -> [ChannelReport] {
        guard let data = pairing.encoded() else {
            return PairingChannel.allCases.map { ChannelReport(channel: $0, ok: false, detail: "编码失败") }
        }
        return PairingChannel.allCases.map { write(data, to: $0) }
    }

    /// First channel that yields a valid pairing, plus a report for every channel.
    static func load() -> (pairing: GatewayPairing?, source: PairingChannel?, reports: [ChannelReport]) {
        var found: (GatewayPairing, PairingChannel)?
        var reports: [ChannelReport] = []
        for channel in PairingChannel.allCases {
            let (data, detail) = read(from: channel)
            if let data, let pairing = try? JSONDecoder().decode(GatewayPairing.self, from: data) {
                reports.append(ChannelReport(channel: channel, ok: true, detail: "读到配对（\(pairing.host)）"))
                if found == nil { found = (pairing, channel) }
            } else {
                reports.append(ChannelReport(channel: channel, ok: false, detail: detail))
            }
        }
        return (found?.0, found?.1, reports)
    }

    static func clear() {
        appGroupDefaults?.removeObject(forKey: defaultsKey)
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        if let group = sharedKeychainGroup { deleteKeychain(group: group) }
    }

    // MARK: Channels

    private static var appGroupDefaults: UserDefaults? {
        appGroupContainerAvailable ? UserDefaults(suiteName: appGroupID) : nil
    }

    private static func write(_ data: Data, to channel: PairingChannel) -> ChannelReport {
        switch channel {
        case .appGroup:
            guard let defaults = appGroupDefaults else {
                return ChannelReport(channel: channel, ok: false, detail: "App 组容器不可用")
            }
            defaults.set(data, forKey: defaultsKey)
            return ChannelReport(channel: channel, ok: true, detail: "已写入")
        case .sharedKeychain:
            guard let group = sharedKeychainGroup else {
                return ChannelReport(channel: channel, ok: false, detail: "无法获取签名团队前缀")
            }
            let status = writeKeychain(data, group: group)
            return ChannelReport(channel: channel, ok: status == errSecSuccess,
                                 detail: status == errSecSuccess ? "已写入 \(group)" : "写入失败 \(status)（\(group)）")
        case .appLocal:
            UserDefaults.standard.set(data, forKey: defaultsKey)
            return ChannelReport(channel: channel, ok: true, detail: "已写入")
        }
    }

    private static func read(from channel: PairingChannel) -> (Data?, String) {
        switch channel {
        case .appGroup:
            guard let defaults = appGroupDefaults else { return (nil, "App 组容器不可用") }
            let data = defaults.data(forKey: defaultsKey)
            return (data, data == nil ? "容器可用，但没有配对" : "")
        case .sharedKeychain:
            guard let group = sharedKeychainGroup else { return (nil, "无法获取签名团队前缀") }
            let (data, status) = readKeychain(group: group)
            return (data, data == nil ? "读取失败 \(status)（\(group)）" : "")
        case .appLocal:
            let data = UserDefaults.standard.data(forKey: defaultsKey)
            return (data, data == nil ? "没有配对" : "")
        }
    }

    private static func baseKeychainQuery(group: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: group,
        ]
    }

    private static func writeKeychain(_ data: Data, group: String) -> OSStatus {
        let query = baseKeychainQuery(group: group)
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        // Widgets refresh while the phone is locked.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil)
    }

    private static func readKeychain(group: String) -> (Data?, OSStatus) {
        var query = baseKeychainQuery(group: group)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status == errSecSuccess ? result as? Data : nil, status)
    }

    private static func deleteKeychain(group: String) {
        SecItemDelete(baseKeychainQuery(group: group) as CFDictionary)
    }
}
