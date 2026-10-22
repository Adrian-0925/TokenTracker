import SwiftUI
import WidgetKit

// Phase-2 diagnostic widget: shows which sharing channel delivered the pairing
// and whether the extension itself can reach the gateway. The real widget
// layouts land in phase 4.

struct DiagnosticEntry: TimelineEntry {
    enum State {
        case unpaired
        case loaded(UsageSnapshot)
        case failed(String)
    }

    let date: Date
    let state: State
    let source: PairingChannel?
    let channels: [ChannelReport]
}

struct DiagnosticProvider: TimelineProvider {
    func placeholder(in context: Context) -> DiagnosticEntry {
        DiagnosticEntry(date: Date(), state: .unpaired, source: nil, channels: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (DiagnosticEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(await makeEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DiagnosticEntry>) -> Void) {
        Task {
            let entry = await makeEntry()
            let next = Calendar.current.date(byAdding: .minute, value: 15, to: entry.date) ?? entry.date
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func makeEntry() async -> DiagnosticEntry {
        let loaded = PairingStore.load()
        // The extension's own UserDefaults never holds the app's pairing, so
        // only the two cross-process channels are meaningful here.
        let channels = loaded.reports.filter { $0.channel != .appLocal }
        guard let pairing = loaded.pairing, loaded.source != .appLocal else {
            return DiagnosticEntry(date: Date(), state: .unpaired, source: nil, channels: channels)
        }
        do {
            var client = GatewayClient(pairing: pairing)
            client.timeout = 8
            switch try await client.fetchSnapshot() {
            case .updated(let snapshot, _):
                return DiagnosticEntry(date: Date(), state: .loaded(snapshot), source: loaded.source, channels: channels)
            case .notModified:
                return DiagnosticEntry(date: Date(), state: .failed("意外收到 304"), source: loaded.source, channels: channels)
            }
        } catch {
            return DiagnosticEntry(date: Date(), state: .failed(error.localizedDescription),
                                   source: loaded.source, channels: channels)
        }
    }
}

struct DiagnosticWidgetView: View {
    let entry: DiagnosticEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch entry.state {
            case .unpaired:
                Text("未读到配对").font(.headline)
            case .loaded(let snapshot):
                Text(UsageFormat.tokens(snapshot.today.totalTokens))
                    .font(.title2.bold())
                    .minimumScaleFactor(0.6)
                Text("今日 · \(UsageFormat.cost(snapshot.today.costUsd))")
                    .font(.caption)
            case .failed(let message):
                Text("取数失败").font(.headline)
                Text(message).font(.caption2).lineLimit(3)
            }
            Spacer(minLength: 0)
            Text("来源：\(entry.source?.rawValue ?? "无")").font(.caption2)
            ForEach(entry.channels) { report in
                Text("\(report.ok ? "✓" : "✗") \(report.channel.rawValue)")
                    .font(.caption2)
                    .foregroundStyle(report.ok ? .green : .secondary)
            }
            Text(entry.date, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct DiagnosticWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TokenTrackerDiagnostic", provider: DiagnosticProvider()) { entry in
            DiagnosticWidgetView(entry: entry)
        }
        .configurationDisplayName("TokenTracker 诊断")
        .description("显示小组件能否读到配对并连上电脑。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct TokenTrackerMobileWidgets: WidgetBundle {
    var body: some Widget {
        DiagnosticWidget()
    }
}
