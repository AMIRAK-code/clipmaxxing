using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Klipz.Desktop;

/// <summary>
/// First-run setup of the Python worker environment (faster-whisper, MediaPipe, ffmpeg ...):
/// find a supported Python, create the venv in the data folder, pip install the worker requirements.
/// Re-runs pip automatically when an update changes requirements.txt.
/// </summary>
internal static class PythonEnv
{
    // MediaPipe / faster-whisper wheels exist for these; newer Pythons usually lag behind.
    private static readonly string[] Supported = ["3.12", "3.11", "3.13"];
    private const string MarkerName = "klipz-requirements.sha256";

    public static bool IsReady(AppPaths paths) =>
        File.Exists(paths.VenvPython) && ReadMarker(paths) == RequirementsHash(paths);

    private static string RequirementsHash(AppPaths paths) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(paths.Requirements)));

    private static string? ReadMarker(AppPaths paths)
    {
        try { return File.ReadAllText(Path.Combine(paths.VenvDir, MarkerName)).Trim(); } catch { return null; }
    }

    /// <summary>Full path of a supported python.exe, or null.</summary>
    public static async Task<string?> FindPythonAsync(Action<string> log)
    {
        foreach (var v in Supported)
        {
            var exe = await ProbeAsync("py", [$"-{v}", "-c", "import sys; print(sys.executable)"]);
            if (exe is not null) return exe;
        }
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        foreach (var v in Supported)
        {
            var nodot = v.Replace(".", "");
            foreach (var candidate in new[] { Path.Combine(local, "Programs", "Python", $"Python{nodot}", "python.exe"), Path.Combine(programFiles, $"Python{nodot}", "python.exe") })
                if (File.Exists(candidate)) return candidate;
        }
        var onPath = AppPaths.FindOnPath("python.exe");
        if (onPath is not null && !onPath.Contains("WindowsApps", StringComparison.OrdinalIgnoreCase))
        {
            var ver = await ProbeAsync(onPath, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
            if (ver is not null && Supported.Contains(ver)) return onPath;
            if (ver is not null) log($"Found Python {ver} at {onPath}, but KLIPZ needs Python {string.Join(", ", Supported)}.");
        }
        return null;
    }

    private static async Task<string?> ProbeAsync(string exe, string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var output = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            return p.ExitCode == 0 && output.Trim().Length > 0 ? output.Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Install Python 3.12 for the current user with winget (only after the person agreed).</summary>
    public static Task<int> InstallPythonWithWingetAsync(Action<string> log) =>
        RunAsync("winget", ["install", "-e", "--id", "Python.Python.3.12", "--scope", "user", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"], null, log);

    public static async Task SetupAsync(AppPaths paths, string python, Action<string> log)
    {
        if (!File.Exists(paths.VenvPython))
        {
            log($"Creating the Python environment in {paths.VenvDir} ...");
            var code = await RunAsync(python, ["-m", "venv", paths.VenvDir], null, log);
            if (code != 0 || !File.Exists(paths.VenvPython)) throw new InvalidOperationException($"Creating the Python environment failed (exit {code}).");
        }
        log("Installing the video worker's Python packages (one time, a few minutes, ~2 GB download) ...");
        await RunAsync(paths.VenvPython, ["-m", "pip", "install", "--upgrade", "pip"], paths.WorkerDir, log);
        var pip = await RunAsync(paths.VenvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", paths.Requirements], paths.WorkerDir, log);
        if (pip != 0) throw new InvalidOperationException($"Installing the Python packages failed (pip exit {pip}). Check your internet connection and try again.");
        File.WriteAllText(Path.Combine(paths.VenvDir, MarkerName), RequirementsHash(paths));
        log("Python environment ready.");
    }

    public static async Task<int> RunAsync(string exe, string[] args, string? cwd, Action<string> log)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (cwd is not null) psi.WorkingDirectory = cwd;
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["PYTHONUNBUFFERED"] = "1";
        using var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) log(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) log(e.Data); };
        try
        {
            p.Start();
        }
        catch (Exception e)
        {
            log($"Could not start {exe}: {e.Message}");
            return -1;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        await p.WaitForExitAsync();
        return p.ExitCode;
    }
}
