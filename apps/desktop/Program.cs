namespace Klipz.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // One KLIPZ at a time: a second copy would fight over the port, the database and the worker.
        using var mutex = new Mutex(true, @"Local\KLIPZ.Desktop.SingleInstance", out var first);
        if (!first)
        {
            MessageBox.Show("KLIPZ is already running.", "KLIPZ", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
