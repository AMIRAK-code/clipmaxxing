namespace Klipz.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One KLIPZ per data folder: a second copy on the same folder would fight over the database and the
        // worker. A copy pointed at another folder (KLIPZ_DATA_DIR, with its own KLIPZ_PORT) is independent.
        using var mutex = new Mutex(true, MutexName(), out var first);
        if (!first)
        {
            MessageBox.Show("KLIPZ is already running.", "KLIPZ", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }

    private static string MutexName()
    {
        const string legacy = @"Local\KLIPZ.Desktop.SingleInstance"; // the name every build uses for the default folder
        var dir = Environment.GetEnvironmentVariable("KLIPZ_DATA_DIR");
        if (string.IsNullOrWhiteSpace(dir)) return legacy;
        var full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant();
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(full));
        return @"Local\KLIPZ.Desktop." + Convert.ToHexString(hash)[..16];
    }
}
