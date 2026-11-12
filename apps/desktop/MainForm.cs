using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Klipz.Desktop;

/// <summary>
/// The KLIPZ window. Shows a startup / first-run setup screen, then hosts the app in WebView2.
/// Platform sign-in (TikTok, Instagram, X, ...) runs inside this window: Connect navigates to the
/// platform's login page, which redirects back to http://localhost:&lt;port&gt;/api/oauth/&lt;provider&gt;/callback.
/// </summary>
internal sealed class MainForm : Form
{
    private static readonly Color Bg = Color.FromArgb(11, 11, 15);
    private static readonly Color Panel2 = Color.FromArgb(24, 24, 31);
    private static readonly Color Fg = Color.FromArgb(235, 235, 240);
    private static readonly Color Muted = Color.FromArgb(150, 150, 165);
    private static readonly Color Accent = Color.FromArgb(124, 92, 255);

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(11, 11, 15) };
    private readonly Panel _overlay = new() { Dock = DockStyle.Fill, BackColor = Bg, Padding = new Padding(48) };
    private readonly Label _title = new() { Text = "KLIPZ", AutoSize = true, Font = new Font("Segoe UI", 28, FontStyle.Bold), ForeColor = Fg };
    private readonly Label _status = new() { AutoSize = false, Height = 64, Dock = DockStyle.Top, Font = new Font("Segoe UI", 11), ForeColor = Muted };
    private readonly TextBox _log = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Panel2, ForeColor = Muted,
        BorderStyle = BorderStyle.None, Font = new Font("Consolas", 9), Visible = false,
    };
    private readonly FlowLayoutPanel _buttons = new() { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(0, 8, 0, 0) };
    private readonly Panel _signinBar = new() { Dock = DockStyle.Top, Height = 36, BackColor = Panel2, Visible = false };
    private readonly Label _signinText = new() { Dock = DockStyle.Fill, ForeColor = Fg, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(12, 0, 0, 0), Font = new Font("Segoe UI", 9.5f) };

    private AppPaths? _paths;
    private Backend? _backend;
    private readonly CancellationTokenSource _cts = new();

    public MainForm()
    {
        Text = "KLIPZ";
        BackColor = Bg;
        MinimumSize = new Size(1024, 680);
        Size = new Size(1440, 920);
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* default icon */ }

        var cancelSignin = MakeButton("Back to KLIPZ", (_, _) => GoHome("/accounts"));
        cancelSignin.Dock = DockStyle.Right;
        cancelSignin.Margin = Padding.Empty;
        _signinBar.Controls.Add(_signinText);
        _signinBar.Controls.Add(cancelSignin);

        var header = new Panel { Dock = DockStyle.Top, Height = 64 };
        header.Controls.Add(_title);
        _overlay.Controls.Add(_log);
        _overlay.Controls.Add(_buttons);
        _overlay.Controls.Add(_status);
        _overlay.Controls.Add(header);

        Controls.Add(_web);
        Controls.Add(_signinBar);
        Controls.Add(_overlay);
        _overlay.BringToFront();
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await StartAsync();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _cts.Cancel();
        _backend?.Dispose();
        base.OnFormClosed(e);
    }

    // ── startup ─────────────────────────────────────────────────────────────

    private async Task StartAsync()
    {
        _buttons.Controls.Clear();
        _log.Clear();
        _log.Visible = false;
        _overlay.Visible = true;
        _overlay.BringToFront();
        try
        {
            SetStatus("Starting KLIPZ ...");
            _paths ??= AppPaths.Resolve();

            if (!PythonEnv.IsReady(_paths))
            {
                if (!await RunFirstTimeSetupAsync(_paths)) return;
            }

            SetStatus("Starting the editor and the video worker ...");
            _backend?.Dispose();
            _backend = new Backend(_paths);
            _backend.Crashed += msg => BeginInvoke(() => ShowError(msg, _backend?.RecentOutput()));
            _backend.Start(_paths.VenvPython);
            await _backend.WaitReadyAsync(TimeSpan.FromSeconds(120), _cts.Token);

            await InitWebViewAsync(_paths);
            _web.CoreWebView2.Navigate(_backend.Url + "/");
            _overlay.Visible = false;
        }
        catch (OperationCanceledException) { /* closing */ }
        catch (Exception ex)
        {
            ShowError(ex.Message, _backend?.RecentOutput());
        }
    }

    /// <summary>Returns false when setup stopped and the screen now shows what to do next.</summary>
    private async Task<bool> RunFirstTimeSetupAsync(AppPaths paths)
    {
        _log.Visible = true;
        SetStatus("First-time setup: preparing the video worker (speech recognition, face tracking, ffmpeg). This happens once.");
        var python = await PythonEnv.FindPythonAsync(Log);
        if (python is null)
        {
            var answer = MessageBox.Show(this,
                "KLIPZ's video worker needs Python 3.11, 3.12 or 3.13, and none was found.\n\n" +
                "Install Python 3.12 now for your Windows user (using winget, from python.org's official package)?",
                "KLIPZ setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes)
            {
                ShowError("Python 3.12 is needed. Install it from https://www.python.org/downloads/ (tick \"Add python.exe to PATH\"), then press Retry.", null);
                return false;
            }
            SetStatus("Installing Python 3.12 ...");
            var code = await PythonEnv.InstallPythonWithWingetAsync(Log);
            python = await PythonEnv.FindPythonAsync(Log);
            if (python is null)
            {
                ShowError($"Python could not be installed automatically (winget exit {code}). Install Python 3.12 from https://www.python.org/downloads/, then press Retry.", null);
                return false;
            }
        }
        Log($"Using Python: {python}");
        SetStatus("First-time setup: installing the video worker's packages. This takes a few minutes and needs internet.");
        await PythonEnv.SetupAsync(paths, python, Log);
        return true;
    }

    private async Task InitWebViewAsync(AppPaths paths)
    {
        if (_web.CoreWebView2 is not null) return;
        CoreWebView2Environment env;
        try
        {
            env = await CoreWebView2Environment.CreateAsync(null, paths.WebViewDataDir);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            throw new InvalidOperationException("The Microsoft Edge WebView2 Runtime is missing. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start KLIPZ again.");
        }
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = Debugger.IsAttached;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;

        // target=_blank links (developer consoles, published posts) open in the person's own browser.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        // While on a platform's sign-in page, show where we are and a way back.
        core.SourceChanged += (_, _) => UpdateSigninBar();
        core.NavigationCompleted += (_, _) => UpdateSigninBar();
        core.DocumentTitleChanged += (_, _) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "KLIPZ" : $"{core.DocumentTitle}";
    }

    private bool IsLocal(Uri u) => u.IsLoopback || u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);

    private void UpdateSigninBar()
    {
        if (!Uri.TryCreate(_web.CoreWebView2?.Source, UriKind.Absolute, out var u) || IsLocal(u))
        {
            _signinBar.Visible = false;
            return;
        }
        _signinText.Text = $"🔒  Signing in at {u.Host} — after you approve, you come back to KLIPZ automatically.";
        _signinBar.Visible = true;
    }

    private void GoHome(string path)
    {
        if (_backend is not null) _web.CoreWebView2?.Navigate(_backend.Url + path);
    }

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp)) return;
        try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { /* no browser */ }
    }

    // ── status screen ───────────────────────────────────────────────────────

    private void SetStatus(string text) => _status.Text = text;

    private void Log(string line)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => Log(line));
            return;
        }
        if (_log.TextLength > 200_000) _log.Text = _log.Text[^100_000..];
        _log.AppendText(line + Environment.NewLine);
    }

    private void ShowError(string message, string? details)
    {
        _signinBar.Visible = false;
        _overlay.Visible = true;
        _overlay.BringToFront();
        _status.ForeColor = Color.FromArgb(248, 113, 113);
        SetStatus(message);
        if (!string.IsNullOrWhiteSpace(details))
        {
            _log.Visible = true;
            Log("");
            Log(details);
        }
        _buttons.Controls.Clear();
        _buttons.Controls.Add(MakeButton("Retry", async (_, _) =>
        {
            _status.ForeColor = Muted;
            _backend?.Dispose();
            _backend = null;
            await StartAsync();
        }, primary: true));
        if (_paths is not null)
            _buttons.Controls.Add(MakeButton("Open logs folder", (_, _) => Process.Start(new ProcessStartInfo(_paths.LogDir) { UseShellExecute = true })));
    }

    private static Button MakeButton(string text, EventHandler onClick, bool primary = false)
    {
        var b = new Button
        {
            Text = text, AutoSize = true, Height = 32, Padding = new Padding(10, 2, 10, 2), FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Accent : Panel2, ForeColor = Fg, Font = new Font("Segoe UI", 9.5f, FontStyle.Bold), Cursor = Cursors.Hand,
        };
        b.FlatAppearance.BorderSize = 0;
        b.Click += onClick;
        return b;
    }
}
