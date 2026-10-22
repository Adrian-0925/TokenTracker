import Foundation

/// Mirrors `/api/mobile/snapshot` (src/lib/mobile-gateway.js `buildSnapshot`).
struct UsageSnapshot: Codable, Equatable {
    struct Totals: Codable, Equatable {
        var totalTokens: Double
        var costUsd: Double
        var conversations: Double?
    }

    struct ModelUsage: Codable, Equatable {
        var model: String
        var totalTokens: Double
        var costUsd: Double
    }

    struct DayUsage: Codable, Equatable {
        var day: String
        var totalTokens: Double
        var costUsd: Double
    }

    var generatedAt: String
    var lastSyncAt: String?
    var machineName: String
    var timeZone: String
    var today: Totals
    var thisMonth: Totals
    var topModelsToday: [ModelUsage]
    var last7Days: [DayUsage]
    var lifetimeTotalTokens: Double
}

enum GatewayError: LocalizedError {
    case badURL
    case unauthorized
    case http(Int)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "配对里的地址无效"
        case .unauthorized: return "令牌无效或已被撤销，请重新配对"
        case .http(let code): return "电脑返回错误 \(code)"
        case .transport(let message): return "连不上电脑：\(message)"
        }
    }
}

struct GatewayClient {
    enum SnapshotResult {
        case updated(UsageSnapshot, etag: String?)
        case notModified
    }

    let pairing: GatewayPairing
    var timeout: TimeInterval = 10

    func fetchSnapshot(etag: String? = nil) async throws -> SnapshotResult {
        guard let base = pairing.baseURL,
              var components = URLComponents(url: base.appendingPathComponent("api/mobile/snapshot"),
                                             resolvingAgainstBaseURL: false)
        else { throw GatewayError.badURL }
        components.queryItems = [URLQueryItem(name: "tz", value: TimeZone.current.identifier)]
        guard let url = components.url else { throw GatewayError.badURL }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw GatewayError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw GatewayError.http(-1) }
        switch http.statusCode {
        case 200:
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let snapshot = try decoder.decode(UsageSnapshot.self, from: data)
            return .updated(snapshot, etag: http.value(forHTTPHeaderField: "ETag"))
        case 304:
            return .notModified
        case 401:
            throw GatewayError.unauthorized
        default:
            throw GatewayError.http(http.statusCode)
        }
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()
}

enum UsageFormat {
    static func tokens(_ value: Double) -> String {
        switch value {
        case 1_000_000_000...: return String(format: "%.2fB", value / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", value / 1_000_000)
        case 1_000...: return String(format: "%.1fK", value / 1_000)
        default: return String(format: "%.0f", value)
        }
    }

    static func cost(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }
}
