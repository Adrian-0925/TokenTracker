import Foundation

/// Connection details for the Windows mobile gateway, as encoded in the QR code
/// shown by the tray's "Phone Access" window:
/// `{"v":1,"host":"100.x.y.z","port":7690,"token":"…","name":"<PC name>"}`.
struct GatewayPairing: Codable, Equatable {
    var v: Int
    var host: String
    var port: Int
    var token: String
    var name: String

    static func parse(_ text: String) -> GatewayPairing? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let pairing = try? JSONDecoder().decode(GatewayPairing.self, from: data),
              pairing.v == 1,
              !pairing.host.isEmpty,
              (1...65535).contains(pairing.port),
              pairing.token.count >= 32
        else { return nil }
        return pairing
    }

    var baseURL: URL? {
        // Bracket IPv6 literals; Tailscale IPv4 and MagicDNS names pass through.
        let hostPart = host.contains(":") ? "[\(host)]" : host
        return URL(string: "http://\(hostPart):\(port)")
    }

    func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }
}
