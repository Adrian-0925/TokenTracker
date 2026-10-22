using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// Loopback client for the companion-phone gateway admin API
/// (<c>/api/mobile-gateway</c> in <c>src/lib/mobile-gateway.js</c>). Every call
/// fetches the per-process local-auth token first, exactly like
/// <see cref="LocalSyncPublisher"/>.
/// </summary>
internal sealed class MobileGatewayClient
{
    private const string LocalAuthHeader = "x-tokentracker-local-auth";
    private static readonly HttpClient Http =
        new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(15) };

    private readonly Func<string> _baseUrl;

    public MobileGatewayClient(Func<string> baseUrl)
    {
        _baseUrl = baseUrl ?? throw new ArgumentNullException(nameof(baseUrl));
    }

    public Task<JsonObject> GetStatusAsync(CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, null, cancellationToken);

    public Task<JsonObject> SetEnabledAsync(bool enabled, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Post, new JsonObject { ["action"] = enabled ? "enable" : "disable" }, cancellationToken);

    public Task<JsonObject> PairAsync(string name, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Post, new JsonObject { ["action"] = "pair", ["name"] = name }, cancellationToken);

    public Task<JsonObject> RevokeAsync(string deviceId, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Post, new JsonObject { ["action"] = "revoke", ["device_id"] = deviceId }, cancellationToken);

    private async Task<JsonObject> SendAsync(HttpMethod method, JsonObject? body, CancellationToken cancellationToken)
    {
        var baseUrl = _baseUrl().TrimEnd('/');
        var token = await GetLocalAuthTokenAsync(baseUrl, cancellationToken);

        using var request = new HttpRequestMessage(method, baseUrl + "/api/mobile-gateway");
        request.Headers.TryAddWithoutValidation(LocalAuthHeader, token);
        if (body is not null)
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

        using var response = await Http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        var json = ParseObject(payload);
        if (!response.IsSuccessStatusCode)
        {
            var code = json["code"]?.GetValue<string>() ?? $"http_{(int)response.StatusCode}";
            throw new MobileGatewayException(code);
        }
        return json;
    }

    private static async Task<string> GetLocalAuthTokenAsync(string baseUrl, CancellationToken cancellationToken)
    {
        using var response = await Http.GetAsync(baseUrl + "/api/local-auth", cancellationToken);
        response.EnsureSuccessStatusCode();
        var token = ParseObject(await response.Content.ReadAsStringAsync(cancellationToken))["token"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(token))
            throw new MobileGatewayException("local_auth_unavailable");
        return token;
    }

    private static JsonObject ParseObject(string payload)
    {
        try
        {
            return JsonNode.Parse(payload) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            return new JsonObject();
        }
    }
}

internal sealed class MobileGatewayException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
