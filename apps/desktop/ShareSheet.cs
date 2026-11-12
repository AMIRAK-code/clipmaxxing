using System.Runtime.InteropServices;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace Klipz.Desktop;

/// <summary>The Windows share sheet (Nearby Sharing, mail, WhatsApp, Phone Link, ...) for one file.</summary>
internal static class ShareSheet
{
    [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
        void ShowShareUIForWindow(IntPtr appWindow);
    }

    private static readonly Guid DataTransferManagerIid = new(0xa5caee9b, 0x8708, 0x49d1, 0x8d, 0x36, 0x67, 0xd2, 0x5a, 0x8d, 0xa0, 0x0c);
    private static DataTransferManager? _manager;
    private static IntPtr _managerWindow;
    private static string? _path;
    private static string _title = "KLIPZ video";

    public static void Show(IntPtr hwnd, string path, string? title)
    {
        _path = path;
        _title = string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(path) : title!;
        var interop = DataTransferManager.As<IDataTransferManagerInterop>();
        if (_manager is null || _managerWindow != hwnd)
        {
            var iid = DataTransferManagerIid;
            var ptr = interop.GetForWindow(hwnd, ref iid);
            _manager = WinRT.MarshalInterface<DataTransferManager>.FromAbi(ptr);
            Marshal.Release(ptr);
            _managerWindow = hwnd;
            _manager.DataRequested += OnDataRequested;
        }
        interop.ShowShareUIForWindow(hwnd);
    }

    private static async void OnDataRequested(DataTransferManager sender, DataRequestedEventArgs e)
    {
        var path = _path;
        if (path is null) return;
        var deferral = e.Request.GetDeferral();
        try
        {
            var file = await StorageFile.GetFileFromPathAsync(path);
            e.Request.Data.Properties.Title = _title;
            e.Request.Data.Properties.Description = Path.GetFileName(path);
            e.Request.Data.SetStorageItems(new IStorageItem[] { file });
        }
        catch (Exception ex)
        {
            e.Request.FailWithDisplayText($"KLIPZ could not share this file: {ex.Message}");
        }
        finally
        {
            deferral.Complete();
        }
    }
}
