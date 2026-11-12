namespace Klipz.Desktop;

/// <summary>Where the app code, the bundled Node runtime and the user data live.</summary>
internal sealed record AppPaths(string AppRoot, string NodeExe, string DataDir)
{
    public string WebDir => Path.Combine(AppRoot, "apps", "web");
    public string WorkerDir => Path.Combine(AppRoot, "apps", "worker");
    public string Requirements => Path.Combine(WorkerDir, "requirements.txt");
    public string VenvDir => Environment.GetEnvironmentVariable("KLIPZ_VENV") is { Length: > 0 } v ? v : Path.Combine(DataDir, "venv");
    public string VenvPython => Path.Combine(VenvDir, "Scripts", "python.exe");
    public string LogDir => Directory.CreateDirectory(Path.Combine(DataDir, "logs")).FullName;
    public string WebViewDataDir => Path.Combine(DataDir, "webview2");
    public string NextBin => Path.Combine(AppRoot, "node_modules", "next", "dist", "bin", "next");

    /// <summary>
    /// Installed layout: KLIPZ.exe next to app\ (the code) and runtime\node\node.exe.
    /// Developer layout: run from the repo (bin\...), so walk up to the folder holding db\migrations and use node from PATH.
    /// </summary>
    public static AppPaths Resolve()
    {
        var exeDir = AppContext.BaseDirectory;
        var dataDir = Environment.GetEnvironmentVariable("KLIPZ_DATA_DIR") is { Length: > 0 } d
            ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".klipz");
        Directory.CreateDirectory(dataDir);

        var installedRoot = Path.Combine(exeDir, "app");
        var bundledNode = Path.Combine(exeDir, "runtime", "node", "node.exe");
        if (Directory.Exists(Path.Combine(installedRoot, "db", "migrations")))
        {
            if (!File.Exists(bundledNode)) throw new InvalidOperationException($"The bundled Node runtime is missing ({bundledNode}). Reinstall KLIPZ.");
            return new AppPaths(installedRoot, bundledNode, dataDir);
        }

        var dir = new DirectoryInfo(exeDir);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "db", "migrations"))) dir = dir.Parent;
        if (dir is null) throw new InvalidOperationException("Could not find the KLIPZ app files next to KLIPZ.exe. Reinstall KLIPZ.");
        var node = FindOnPath("node.exe") ?? throw new InvalidOperationException("Node.js was not found on PATH (developer mode).");
        return new AppPaths(dir.FullName, node, dataDir);
    }

    public static string? FindOnPath(string exe)
    {
        foreach (var p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var full = Path.Combine(p.Trim('"'), exe);
                if (File.Exists(full)) return full;
            }
            catch (ArgumentException) { /* bad PATH entry */ }
        }
        return null;
    }
}
