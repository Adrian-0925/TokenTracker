import SwiftUI
import UIKit
import WidgetKit

/// Phase-2 diagnostic screen: pair with the Windows gateway, test the
/// connection, and report which app↔widget sharing channels survive
/// free-Apple-ID re-signing. Replaced by the real dashboard in phase 3.
struct DiagnosticsView: View {
    @State private var pairing: GatewayPairing?
    @State private var pairingSource: PairingChannel?
    @State private var saveReports: [ChannelReport] = []
    @State private var loadReports: [ChannelReport] = []
    @State private var showScanner = false
    @State private var message: String?
    @State private var fetchState: FetchState = .idle
    @State private var environment = EnvironmentReport.current()

    enum FetchState {
        case idle
        case loading
        case success(UsageSnapshot, milliseconds: Int)
        case failure(String)
    }

    var body: some View {
        NavigationStack {
            List {
                pairingSection
                connectionSection
                environmentSection
                channelSection
            }
            .navigationTitle("TokenTracker 诊断")
            .sheet(isPresented: $showScanner) {
                QRScannerView { payload in
                    showScanner = false
                    apply(payloadText: payload)
                }
                .ignoresSafeArea()
            }
            .alert("提示", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("好", role: .cancel) {}
            } message: {
                Text(message ?? "")
            }
            .onAppear(perform: reload)
        }
    }

    // MARK: Sections

    private var pairingSection: some View {
        Section("配对") {
            if let pairing {
                LabeledContent("电脑", value: pairing.name)
                LabeledContent("地址", value: "\(pairing.host):\(pairing.port)")
                LabeledContent("读取自", value: pairingSource?.rawValue ?? "-")
            } else {
                Text("还没有配对。在 Windows 托盘菜单打开“手机访问…”，勾选允许后点“配对新手机”。")
                    .foregroundStyle(.secondary)
            }
            Button("扫码配对") {
                if QRScannerView.isAvailable {
                    showScanner = true
                } else {
                    message = "这台设备不支持扫码，或没有相机权限。可以改用“粘贴配对码”。"
                }
            }
            Button("粘贴配对码") {
                apply(payloadText: UIPasteboard.general.string ?? "")
            }
            if pairing != nil {
                Button("清除配对", role: .destructive) {
                    PairingStore.clear()
                    saveReports = []
                    fetchState = .idle
                    reload()
                    WidgetCenter.shared.reloadAllTimelines()
                }
            }
        }
    }

    private var connectionSection: some View {
        Section("连接测试") {
            Button("获取数据") { Task { await fetch() } }
                .disabled(pairing == nil)
            switch fetchState {
            case .idle:
                EmptyView()
            case .loading:
                ProgressView()
            case .success(let snapshot, let ms):
                LabeledContent("今日 token", value: UsageFormat.tokens(snapshot.today.totalTokens))
                LabeledContent("今日费用", value: UsageFormat.cost(snapshot.today.costUsd))
                LabeledContent("本月 token", value: UsageFormat.tokens(snapshot.thisMonth.totalTokens))
                LabeledContent("电脑最后同步", value: snapshot.lastSyncAt ?? "-")
                LabeledContent("耗时", value: "\(ms) ms")
            case .failure(let error):
                Text(error).foregroundStyle(.red)
            }
            Button("刷新小组件") {
                WidgetCenter.shared.reloadAllTimelines()
                message = "已请求刷新。回到桌面看小组件上显示的“配对来源”和数据。"
            }
        }
    }

    private var environmentSection: some View {
        Section("签名环境") {
            LabeledContent("Bundle ID", value: environment.bundleID)
            LabeledContent("团队前缀", value: environment.teamPrefix ?? "获取失败")
            LabeledContent("App 组容器", value: environment.appGroupAvailable ? "可用" : "不可用")
            LabeledContent("版本", value: environment.version)
        }
    }

    private var channelSection: some View {
        Section {
            ForEach(saveReports) { report in
                reportRow(title: "写入 · \(report.channel.rawValue)", report: report)
            }
            ForEach(loadReports) { report in
                reportRow(title: "读取 · \(report.channel.rawValue)", report: report)
            }
        } header: {
            Text("共享方式（App 端）")
        } footer: {
            Text("小组件上会显示它自己读到的结果。两边都能读到的方式，就是正式版要用的。")
        }
    }

    private func reportRow(title: String, report: ChannelReport) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(title, systemImage: report.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(report.ok ? .green : .red)
            if !report.detail.isEmpty {
                Text(report.detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Actions

    private func apply(payloadText: String) {
        guard let parsed = GatewayPairing.parse(payloadText) else {
            message = "没有识别出有效的配对码。"
            return
        }
        saveReports = PairingStore.save(parsed)
        reload()
        WidgetCenter.shared.reloadAllTimelines()
        Task { await fetch() }
    }

    private func reload() {
        let loaded = PairingStore.load()
        pairing = loaded.pairing
        pairingSource = loaded.source
        loadReports = loaded.reports
        environment = EnvironmentReport.current()
    }

    private func fetch() async {
        guard let pairing else { return }
        fetchState = .loading
        let start = Date()
        do {
            switch try await GatewayClient(pairing: pairing).fetchSnapshot() {
            case .updated(let snapshot, _):
                fetchState = .success(snapshot, milliseconds: Int(Date().timeIntervalSince(start) * 1000))
                WidgetCenter.shared.reloadAllTimelines()
            case .notModified:
                fetchState = .failure("意外收到 304")
            }
        } catch {
            fetchState = .failure(error.localizedDescription)
        }
    }
}

struct EnvironmentReport {
    var bundleID: String
    var teamPrefix: String?
    var appGroupAvailable: Bool
    var version: String

    static func current() -> EnvironmentReport {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return EnvironmentReport(
            bundleID: Bundle.main.bundleIdentifier ?? "?",
            teamPrefix: PairingStore.appIdentifierPrefix(),
            appGroupAvailable: PairingStore.appGroupContainerAvailable,
            version: "\(short) (\(build))"
        )
    }
}
