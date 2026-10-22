using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using QRCoder;

namespace TokenTrackerWin;

/// <summary>
/// Companion-phone settings: turn the Tailscale gateway on/off, pair a phone by
/// QR code, and revoke paired phones. All state lives in the local server
/// (<c>src/lib/mobile-gateway.js</c>); this window only drives its admin API.
/// </summary>
internal sealed class MobileAccessForm : Form
{
    private readonly MobileGatewayClient _client;
    private readonly MobileAccessStrings _strings;
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 5000 };

    private readonly CheckBox _enabledBox;
    private readonly Label _statusLabel;
    private readonly Button _pairButton;
    private readonly PictureBox _qrBox;
    private readonly Label _qrHint;
    private readonly ListView _devices;
    private readonly Button _revokeButton;
    private readonly Button _revokeAllButton;

    private bool _applyingStatus;
    private bool _busy;

    public MobileAccessForm(MobileGatewayClient client, string locale, string fontFamily)
    {
        _client = client;
        _strings = MobileAccessStrings.For(locale);

        Text = _strings.WindowTitle;
        Font = new Font(fontFamily, 9.5f, FontStyle.Regular, GraphicsUnit.Point);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);

        _enabledBox = new CheckBox { Text = _strings.EnableCheckbox, AutoSize = true };
        _enabledBox.CheckedChanged += async (_, _) =>
        {
            if (_applyingStatus) return;
            await RunAsync(() => _client.SetEnabledAsync(_enabledBox.Checked));
        };

        _statusLabel = new Label { AutoSize = true, MaximumSize = new Size(460, 0), Margin = new Padding(3, 6, 3, 12) };

        _pairButton = new Button { Text = _strings.PairButton, AutoSize = true };
        _pairButton.Click += async (_, _) => await PairAsync();

        _qrBox = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(260, 260), Visible = false };
        _qrHint = new Label { Text = _strings.PairHint, AutoSize = true, MaximumSize = new Size(460, 0), Visible = false };

        var devicesTitle = new Label { Text = _strings.DevicesTitle, AutoSize = true, Margin = new Padding(3, 16, 3, 4) };
        _devices = new ListView
        {
            View = View.Details,
            FullRowSelect = true,
            MultiSelect = false,
            HeaderStyle = ColumnHeaderStyle.Nonclickable,
            Size = new Size(460, 140),
        };
        _devices.Columns.Add(_strings.ColumnName, 150);
        _devices.Columns.Add(_strings.ColumnPaired, 150);
        _devices.Columns.Add(_strings.ColumnLastSeen, 150);
        _devices.SelectedIndexChanged += (_, _) => _revokeButton!.Enabled = _devices.SelectedItems.Count > 0 && !_busy;

        _revokeButton = new Button { Text = _strings.RevokeSelected, AutoSize = true, Enabled = false };
        _revokeButton.Click += async (_, _) =>
        {
            if (_devices.SelectedItems.Count == 0) return;
            var id = (string)_devices.SelectedItems[0].Tag!;
            await RunAsync(() => _client.RevokeAsync(id));
        };
        _revokeAllButton = new Button { Text = _strings.RevokeAll, AutoSize = true };
        _revokeAllButton.Click += async (_, _) =>
        {
            if (MessageBox.Show(this, _strings.RevokeAllConfirm, _strings.WindowTitle,
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
            await RunAsync(() => _client.RevokeAsync("*"));
        };

        var revokeRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0) };
        revokeRow.Controls.Add(_revokeButton);
        revokeRow.Controls.Add(_revokeAllButton);

        var layout = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Dock = DockStyle.Fill,
        };
        layout.Controls.AddRange([_enabledBox, _statusLabel, _pairButton, _qrBox, _qrHint, devicesTitle, _devices, revokeRow]);
        Controls.Add(layout);

        _refreshTimer.Tick += async (_, _) => { if (!_busy) await RefreshStatusAsync(); };
        Shown += async (_, _) =>
        {
            await RefreshStatusAsync();
            _refreshTimer.Start();
        };
        FormClosed += (_, _) =>
        {
            _refreshTimer.Dispose();
            // The QR holds a live token; drop the image with the window.
            _qrBox.Image?.Dispose();
            Font.Dispose();
        };
    }

    private async Task PairAsync()
    {
        await RunAsync(async () =>
        {
            var result = await _client.PairAsync(_strings.DefaultDeviceName);
            var uri = result["pairing_uri"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(uri)) ShowQr(uri);
            return await _client.GetStatusAsync();
        });
    }

    private void ShowQr(string payload)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(data).GetGraphic(10);
        var previous = _qrBox.Image;
        _qrBox.Image = Image.FromStream(new MemoryStream(png));
        previous?.Dispose();
        _qrBox.Visible = true;
        _qrHint.Visible = true;
    }

    private async Task RefreshStatusAsync()
    {
        try
        {
            ApplyStatus(await _client.GetStatusAsync());
        }
        catch (Exception)
        {
            _statusLabel.Text = _strings.StatusUnavailable;
        }
    }

    private async Task RunAsync(Func<Task<JsonObject>> action)
    {
        if (_busy) return;
        _busy = true;
        SetControlsEnabled(false);
        try
        {
            ApplyStatus(await action());
        }
        catch (MobileGatewayException ex)
        {
            ShowError(ex.Code);
            await RefreshStatusAsync();
        }
        catch (Exception ex)
        {
            ShowError(ex.GetType().Name);
            await RefreshStatusAsync();
        }
        finally
        {
            _busy = false;
            SetControlsEnabled(true);
        }
    }

    private void ShowError(string code)
    {
        var message = code switch
        {
            "tailscale_not_found" => _strings.ErrorTailscaleNotFound,
            "gateway_not_listening" => _strings.ErrorNotListening,
            "too_many_devices" => _strings.ErrorTooManyDevices,
            _ => string.Format(CultureInfo.CurrentCulture, _strings.ErrorGenericFormat, code),
        };
        MessageBox.Show(this, message, _strings.WindowTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void SetControlsEnabled(bool enabled)
    {
        _enabledBox.Enabled = enabled;
        _pairButton.Enabled = enabled;
        _revokeAllButton.Enabled = enabled && _devices.Items.Count > 0;
        _revokeButton.Enabled = enabled && _devices.SelectedItems.Count > 0;
    }

    private void ApplyStatus(JsonObject status)
    {
        if (status["status"] is null) return;   // revoke/pair replies without a status block

        _applyingStatus = true;
        try
        {
            _enabledBox.Checked = status["enabled"]?.GetValue<bool>() == true;
        }
        finally
        {
            _applyingStatus = false;
        }

        var state = status["status"]?.GetValue<string>() ?? "";
        var host = status["host"]?.GetValue<string>();
        var port = status["port"]?.GetValue<int>() ?? 0;
        _statusLabel.Text = state switch
        {
            "listening" => string.Format(CultureInfo.CurrentCulture, _strings.StatusListeningFormat, $"{host}:{port}"),
            "waiting_for_tailscale" => _strings.StatusWaitingForTailscale,
            "error" => string.Format(CultureInfo.CurrentCulture, _strings.StatusErrorFormat, status["error"]?.GetValue<string>() ?? ""),
            _ => _strings.StatusDisabled,
        };

        var selectedId = _devices.SelectedItems.Count > 0 ? _devices.SelectedItems[0].Tag as string : null;
        _devices.BeginUpdate();
        _devices.Items.Clear();
        foreach (var node in status["devices"] as JsonArray ?? [])
        {
            if (node is not JsonObject device) continue;
            var id = device["id"]?.GetValue<string>() ?? "";
            var item = new ListViewItem(device["name"]?.GetValue<string>() ?? "") { Tag = id };
            item.SubItems.Add(FormatTime(device["createdAt"]?.GetValue<string>()));
            item.SubItems.Add(FormatTime(device["lastSeenAt"]?.GetValue<string>()));
            _devices.Items.Add(item);
            if (id == selectedId) item.Selected = true;
        }
        _devices.EndUpdate();
        _revokeAllButton.Enabled = !_busy && _devices.Items.Count > 0;
        _revokeButton.Enabled = !_busy && _devices.SelectedItems.Count > 0;
    }

    private string FormatTime(string? iso)
    {
        if (string.IsNullOrEmpty(iso) ||
            !DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value))
            return _strings.Never;
        return value.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.CurrentCulture);
    }
}
