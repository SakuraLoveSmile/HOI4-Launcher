"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const CACHE_MS = 60_000;
const QUERY_TIMEOUT_MS = 12_000;

// Fixed, read-only Win32 calls. No user-controlled values are interpolated here.
// EnumDisplayMonitors supplies active desktop monitors; adapter flags exclude
// mirroring drivers. Current settings are read without calling ChangeDisplaySettings.
const DISPLAY_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class IroncladDisplayReader {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public uint cbSize;
    public RECT rcMonitor, rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public uint cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public uint StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public uint dmFields;
    public int dmPositionX, dmPositionY;
    public uint dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }

  public class Mode {
    public uint width { get; set; }
    public uint height { get; set; }
    public uint refreshRate { get; set; }
  }

  public class Display {
    public string deviceName { get; set; }
    public string name { get; set; }
    public bool primary { get; set; }
    public uint width { get; set; }
    public uint height { get; set; }
    public uint refreshRate { get; set; }
    public List<Mode> modes { get; set; }
  }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "EnumDisplayDevicesW")]
  private static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE display, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "EnumDisplaySettingsExW")]
  private static extern bool EnumDisplaySettingsEx(string device, int modeIndex, ref DEVMODE mode, uint flags);
  [DllImport("user32.dll")]
  private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
  private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);

  private static DEVMODE NewMode() {
    DEVMODE mode = new DEVMODE();
    mode.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    return mode;
  }

  private static DISPLAY_DEVICE NewDevice() {
    DISPLAY_DEVICE device = new DISPLAY_DEVICE();
    device.cb = (uint)Marshal.SizeOf(typeof(DISPLAY_DEVICE));
    return device;
  }

  public static List<Display> Read() {
    var activeAdapters = new Dictionary<string, DISPLAY_DEVICE>(StringComparer.OrdinalIgnoreCase);
    for (uint index = 0; index < 64; index++) {
      DISPLAY_DEVICE device = NewDevice();
      if (!EnumDisplayDevices(null, index, ref device, 0)) break;
      if ((device.StateFlags & 1) != 0 && (device.StateFlags & 8) == 0) activeAdapters[device.DeviceName] = device;
    }
    var result = new List<Display>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      if (result.Count >= 32) return false;
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfo(monitor, ref info) || !activeAdapters.ContainsKey(info.szDevice) || !seen.Add(info.szDevice)) return true;
      DEVMODE current = NewMode();
      if (!EnumDisplaySettingsEx(info.szDevice, -1, ref current, 0)) return true;
      if (current.dmPelsWidth == 0 || current.dmPelsHeight == 0) return true;
      string label = activeAdapters[info.szDevice].DeviceString;
      for (uint childIndex = 0; childIndex < 32; childIndex++) {
        DISPLAY_DEVICE child = NewDevice();
        if (!EnumDisplayDevices(info.szDevice, childIndex, ref child, 0)) break;
        if ((child.StateFlags & 1) != 0 && !String.IsNullOrWhiteSpace(child.DeviceString)) { label = child.DeviceString; break; }
      }
      var modes = new List<Mode>();
      for (int modeIndex = 0; modeIndex < 8192; modeIndex++) {
        DEVMODE mode = NewMode();
        if (!EnumDisplaySettingsEx(info.szDevice, modeIndex, ref mode, 0)) break;
        modes.Add(new Mode { width = mode.dmPelsWidth, height = mode.dmPelsHeight, refreshRate = mode.dmDisplayFrequency });
      }
      result.Add(new Display { deviceName = info.szDevice, name = label, primary = (info.dwFlags & 1) != 0, width = current.dmPelsWidth, height = current.dmPelsHeight, refreshRate = current.dmDisplayFrequency, modes = modes });
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return result;
  }
}
'@ | Out-Null
$displays = @([IroncladDisplayReader]::Read())
ConvertTo-Json -InputObject $displays -Depth 5 -Compress
`;

const encodedQuery = Buffer.from(DISPLAY_QUERY, "utf16le").toString("base64");
const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validDimension = (width, height) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width >= 320 &&
  width <= 32768 &&
  height >= 200 &&
  height <= 32768;
const validRate = (rate) => Number.isFinite(rate) && rate > 1 && rate <= 1000;

function parseSnapshot(stdout) {
  let records;
  try {
    records = JSON.parse(
      String(stdout)
        .replace(/^\uFEFF/, "")
        .trim(),
    );
  } catch {
    throw new Error("Windows 返回的显示器数据无法解析，请重试显示器检测。");
  }
  if (!Array.isArray(records) || records.length > 32)
    throw new Error("Windows 返回的显示器列表格式无效。");
  if (!records.length)
    throw new Error(
      "未检测到可用的桌面显示器，请确认显示器已连接并处于活动状态。",
    );
  const seen = new Set();
  const parsed = records.map((record, order) => {
    if (
      !isObject(record) ||
      typeof record.deviceName !== "string" ||
      !/^\\\\\.\\DISPLAY\d+$/i.test(record.deviceName) ||
      typeof record.primary !== "boolean" ||
      !validDimension(record.width, record.height) ||
      !Number.isFinite(record.refreshRate) ||
      record.refreshRate < 0 ||
      record.refreshRate > 1000 ||
      !Array.isArray(record.modes) ||
      record.modes.length > 8192
    )
      throw new Error("Windows 返回了无效的显示器参数，请重新检测。");
    const identity = record.deviceName.toUpperCase();
    if (seen.has(identity))
      throw new Error("Windows 返回了重复的显示器，请重新检测。");
    seen.add(identity);
    const name =
      typeof record.name === "string"
        ? record.name
            .replace(/[\0-\x1f]/g, " ")
            .trim()
            .slice(0, 160)
        : "";
    const currentResolution = `${record.width}x${record.height}`;
    // DEVMODE rates 0 and 1 mean driver default, not an advertised 1 Hz mode.
    const currentRefreshRate = validRate(record.refreshRate)
      ? record.refreshRate
      : 0;
    const modes = new Map();
    const addMode = (width, height, rate) => {
      if (!validDimension(width, height)) return;
      const resolution = `${width}x${height}`;
      if (!modes.has(resolution)) modes.set(resolution, new Set());
      if (validRate(rate)) modes.get(resolution).add(rate);
    };
    for (const mode of record.modes) {
      if (!isObject(mode) || typeof mode.refreshRate !== "number") continue;
      addMode(mode.width, mode.height, mode.refreshRate);
    }
    // The active mode itself is evidence even when the driver omits it from enumeration.
    addMode(record.width, record.height, currentRefreshRate);
    const resolutions = [...modes.keys()].sort((a, b) => {
      const [aw, ah] = a.split("x").map(Number),
        [bw, bh] = b.split("x").map(Number);
      return bw * bh - aw * ah || bw - aw || bh - ah;
    });
    return {
      order,
      name: name ? `${name} (${record.deviceName})` : record.deviceName,
      primary: record.primary,
      currentResolution,
      currentRefreshRate,
      resolutions,
      refreshRatesByResolution: Object.fromEntries(
        resolutions.map((resolution) => [
          resolution,
          [...modes.get(resolution)].sort((a, b) => b - a),
        ]),
      ),
    };
  });
  // SDL's Windows backend normally places the primary monitor first. Other indices
  // retain EnumDisplayMonitors order; a future SDL version may enumerate differently.
  return parsed
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order)
    .map(({ order, ...display }, index) => ({ index, ...display }));
}

function queryError(error) {
  if (error?.code === "ENOENT")
    return new Error("找不到 Windows PowerShell，无法读取显示器模式。");
  if (
    error?.killed ||
    error?.code === "ETIMEDOUT" ||
    error?.signal === "SIGTERM"
  )
    return new Error("读取显示器模式超时，请稍后重试。");
  return new Error("无法读取 Windows 显示器模式，请检查显示驱动后重试。");
}

/**
 * execFileImpl is compatible with node:child_process.execFile's callback API.
 * Returned resolutions use physical pixels and Win32-advertised Hz, without scaling.
 * currentRefreshRate 0 means the driver reports an unspecified/default rate.
 */
function createDisplayService({ execFileImpl = execFile } = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;
  async function getDisplays() {
    const now = Date.now();
    if (cached && now >= cachedAt && now - cachedAt < CACHE_MS)
      return clone(cached);
    if (!pending) {
      pending = new Promise((resolve, reject) => {
        const executable = path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        try {
          execFileImpl(
            executable,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              encodedQuery,
            ],
            {
              windowsHide: true,
              timeout: QUERY_TIMEOUT_MS,
              maxBuffer: 4 * 1024 * 1024,
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error) {
                reject(queryError(error));
                return;
              }
              try {
                resolve(parseSnapshot(stdout));
              } catch (parseError) {
                reject(parseError);
              }
            },
          );
        } catch (error) {
          reject(queryError(error));
        }
      })
        .then((result) => {
          cached = result;
          cachedAt = Date.now();
          return result;
        })
        .finally(() => {
          pending = null;
        });
    }
    return clone(await pending);
  }
  return { getDisplays };
}

module.exports = { createDisplayService };
