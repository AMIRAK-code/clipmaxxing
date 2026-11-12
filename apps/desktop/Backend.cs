using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Klipz.Desktop;

/// <summary>Runs the Next.js web server and the Python worker as hidden child processes inside a kill-on-close job.</summary>
internal sealed class Backend : IDisposable
{
    private readonly AppPaths _paths;
    private readonly JobObject _job = new();
    private readonly List<Process> _procs = new();
    private readonly Queue<string> _tail = new();
    private volatile bool _stopping;

    public int Port { get; }
    public int WorkerPort { get; }
    public string Url => $"http://localhost:{Port}";

    /// <summary>Raised (on a thread-pool thread) when a child exits while KLIPZ is still running.</summary>
    public event Action<string>? Crashed;

    public Backend(AppPaths paths)
    {
        _paths = paths;
        Port = EnvPort("KLIPZ_PORT", 3000);
        WorkerPort = EnvPort("KLIPZ_WORKER_PORT", 8787);
    }

    private static int EnvPort(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var p) && p is > 0 and < 65536 ? p : fallback;

    public static bool PortFree(int port)
    {
        try
        {
            var l = new TcpListener(IPAddress.Loopback, port);
            l.Start();
            l.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    public string RecentOutput()
    {
        lock (_tail) return string.Join(Environment.NewLine, _tail);
    }

    public void Start(string venvPython)
    {
        if (!PortFree(Port))
            throw new InvalidOperationException(
                $"Port {Port} is already in use. Close the program using it (or another KLIPZ started with `npm start`), then open KLIPZ again.\n\n" +
                "The sign-in redirect URIs you registered with TikTok, Meta and X contain this port, so KLIPZ does not silently pick another one. " +
                "To use a different port, set the KLIPZ_PORT environment variable and update the redirect URIs.");
        if (!PortFree(WorkerPort)) throw new InvalidOperationException($"Worker port {WorkerPort} is already in use. Set KLIPZ_WORKER_PORT to a free port.");

        var nodeDir = Path.GetDirectoryName(_paths.NodeExe)!;
        var env = new Dictionary<string, string>
        {
            ["KLIPZ_PORT"] = Port.ToString(),
            ["KLIPZ_WORKER_PORT"] = WorkerPort.ToString(),
            ["KLIPZ_DATA_DIR"] = _paths.DataDir,
            ["KLIPZ_DESKTOP"] = "1",
            ["NODE_ENV"] = "production",
            ["NEXT_TELEMETRY_DISABLED"] = "1",
            ["PYTHONUNBUFFERED"] = "1",
            // The worker renders by running `node packages/video/render.mjs`: put the bundled node first on PATH.
            ["PATH"] = nodeDir + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH"),
        };
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APP_URL"))) env["APP_URL"] = Url;

        Launch("worker", venvPython, ["-u", "-m", "klipz_worker.main", "--port", WorkerPort.ToString()], _paths.WorkerDir, env);
        // Installed app: Next's standalone server (starts in about a second). Repo checkout: `next start`.
        var standalone = Path.Combine(_paths.WebDir, "server.js");
        if (File.Exists(standalone))
        {
            env["PORT"] = Port.ToString();
            env["HOSTNAME"] = "127.0.0.1";
            Launch("web", _paths.NodeExe, [standalone], _paths.WebDir, env);
        }
        else
        {
            Launch("web", _paths.NodeExe, [_paths.NextBin, "start", "-H", "127.0.0.1", "-p", Port.ToString()], _paths.WebDir, env);
        }
    }

    private void Launch(string name, string exe, string[] args, string cwd, Dictionary<string, string> env)
    {
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        foreach (var (k, v) in env) psi.Environment[k] = v;

        var logFile = new StreamWriter(Path.Combine(_paths.LogDir, $"desktop-{name}.log"), append: false, Encoding.UTF8) { AutoFlush = true };
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        void OnLine(string? line)
        {
            if (line is null) return;
            lock (logFile) logFile.WriteLine(line);
            lock (_tail)
            {
                _tail.Enqueue($"{name} | {line}");
                while (_tail.Count > 60) _tail.Dequeue();
            }
        }
        p.OutputDataReceived += (_, e) => OnLine(e.Data);
        p.ErrorDataReceived += (_, e) => OnLine(e.Data);
        p.Exited += (_, _) =>
        {
            if (_stopping) return;
            Crashed?.Invoke($"The {name} process stopped unexpectedly (exit code {SafeExitCode(p)}).");
        };
        p.Start();
        try
        {
            _job.Add(p);
        }
        catch
        {
            // Without the job the child could outlive KLIPZ; better to fail loudly.
            try { p.Kill(entireProcessTree: true); } catch { /* gone */ }
            throw;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        _procs.Add(p);
    }

    private static string SafeExitCode(Process p)
    {
        try { return p.ExitCode.ToString(); } catch { return "?"; }
    }

    /// <summary>Wait until the web server answers HTTP (any status) or a child dies.</summary>
    public async Task WaitReadyAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (_procs.Any(p => p.HasExited)) throw new InvalidOperationException("KLIPZ's background services stopped while starting.");
            try
            {
                using var res = await http.GetAsync($"http://127.0.0.1:{Port}/api/system/status", ct);
                return;
            }
            catch (HttpRequestException) { /* not listening yet */ }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { /* request timeout */ }
            await Task.Delay(400, ct);
        }
        throw new TimeoutException("KLIPZ's web server did not start within " + (int)timeout.TotalSeconds + " seconds.");
    }

    public void Dispose()
    {
        _stopping = true;
        _job.Dispose(); // kills both trees
        foreach (var p in _procs) p.Dispose();
    }
}
