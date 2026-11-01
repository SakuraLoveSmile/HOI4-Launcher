using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A separate, windowless process owns sampling. It never opens a game for writing,
// injects code, changes process priority, or depends on the launcher's lifetime.
internal static class GamePerformanceMonitor {
  private const int ConfigLimit = 65536;
  private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

  [DllImport("kernel32.dll")]
  private static extern uint GetActiveProcessorCount(ushort groupNumber);

  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdentity {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(IntPtr file, out FileIdentity identity);

  private static void CheckRegularFile(string file) {
    if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
      throw new IOException("Unsafe statistics file.");
    using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete)) {
      FileIdentity identity;
      if (!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(), out identity) || identity.Links != 1)
        throw new IOException("Linked statistics file.");
    }
  }

  internal static JavaScriptSerializer Serializer() {
    return new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024, RecursionLimit = 16 };
  }

  internal static string Iso(DateTime value) {
    return value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
  }

  private static int Main(string[] args) {
    if (args.Length != 1) return 2;
    Dictionary<string, object> config;
    string directory;
    try {
      string file = Path.GetFullPath(args[0]);
      directory = Path.GetDirectoryName(file);
      Guid sessionId;
      if (Path.GetFileName(file) != "session.json" ||
          !Guid.TryParse(Path.GetFileName(directory), out sessionId) ||
          Path.GetFileName(Path.GetDirectoryName(directory)) != "sessions") return 2;
      CheckDirectory(directory);
      FileInfo info = new FileInfo(file);
      if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > ConfigLimit) return 2;
      CheckRegularFile(file);
      config = Serializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Utf8));
      if (Convert.ToInt32(config["schemaVersion"]) != 1 ||
          !String.Equals((string)config["id"], sessionId.ToString("D"), StringComparison.OrdinalIgnoreCase)) return 2;
    } catch { return 2; }

    PerformanceAccumulator accumulator = null;
    SessionWriter writer = null;
    Stopwatch timer = Stopwatch.StartNew();
    double offset = 0;
    DateTime started;
    try {
      if (!DateTime.TryParse((string)config["launchedAt"], CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind, out started)) return 2;
      started = started.ToUniversalTime();
      int processId = Convert.ToInt32(config["pid"]);
      int interval = Convert.ToInt32(config["intervalMs"]);
      if (processId < 1 || interval < 250 || interval > 60000) return 2;
      Dictionary<string, object> initial = (Dictionary<string, object>)config["session"];
      uint nativeCount;
      try { nativeCount = GetActiveProcessorCount(0xffff); }
      catch { nativeCount = 0; }
      int cores = nativeCount > 0 && nativeCount <= 4096 ? (int)nativeCount : Environment.ProcessorCount;
      accumulator = new PerformanceAccumulator(initial, Math.Max(1, cores), 2400);
      writer = new SessionWriter(directory, (string)config["id"]);
      // CreateNew keeps a second collector from replacing another collector's files.
      using (FileStream ownership = new FileStream(Path.Combine(directory, "monitor.lock"),
          FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
        byte[] identity = Utf8.GetBytes(Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
        ownership.Write(identity, 0, identity.Length);
        ownership.Flush(true);
        writer.Initialize();
        using (Process target = Process.GetProcessById(processId)) {
          DateTime processStart = target.StartTime.ToUniversalTime();
          string image = NormalizePath(target.MainModule.FileName);
          bool imageMatches = String.Equals(image, NormalizePath((string)config["executable"]), StringComparison.OrdinalIgnoreCase);
          object canonicalImage;
          if (!imageMatches && config.TryGetValue("canonicalExecutable", out canonicalImage) && canonicalImage is string)
            imageMatches = String.Equals(image, NormalizePath((string)canonicalImage), StringComparison.OrdinalIgnoreCase);
          if (!imageMatches || processStart < started.AddSeconds(-15) || processStart > started.AddSeconds(3))
            throw new MonitorFailure("identity-mismatch");
          accumulator.ProcessStartedAt = Iso(processStart);
          accumulator.ProcessStartTicks = processStart.Ticks.ToString(CultureInfo.InvariantCulture);
          offset = Math.Max(0, (DateTime.UtcNow - started).TotalMilliseconds);
          timer.Restart();
          int failures = 0;
          for (;;) {
            target.Refresh();
            if (target.HasExited) {
              DateTime ended;
              try { ended = target.ExitTime.ToUniversalTime(); }
              catch { ended = DateTime.UtcNow; }
              // UTC can jump while playing. Only the monotonic clock measures duration;
              // the real process exit timestamp remains useful as a calendar label.
              double duration = Math.Max(accumulator.LastElapsedMs, offset + timer.Elapsed.TotalMilliseconds);
              writer.WriteSummary(accumulator.Summary("completed", ended, Math.Max(0, duration), null));
              return 0;
            }
            if (target.StartTime.ToUniversalTime().Ticks != processStart.Ticks)
              throw new MonitorFailure("identity-mismatch");
            double? cpu = null;
            long? memory = null, privateMemory = null, peakMemory = null;
            try { cpu = target.TotalProcessorTime.TotalMilliseconds; } catch { }
            try { memory = target.WorkingSet64; } catch { }
            try { privateMemory = target.PrivateMemorySize64; } catch { }
            try { peakMemory = target.PeakWorkingSet64; } catch { }
            if (!cpu.HasValue && !memory.HasValue && !privateMemory.HasValue) {
              if (target.HasExited) continue;
              failures++;
            } else failures = 0;
            if (failures >= 3) throw new MonitorFailure("metrics-unavailable");
            double elapsed = offset + timer.Elapsed.TotalMilliseconds;
            bool compacted = accumulator.Add(elapsed, DateTime.UtcNow, cpu, memory, privateMemory, peakMemory);
            writer.WriteSample(accumulator, compacted);
            writer.WriteSummary(accumulator.Summary("recording", null, elapsed, null));
            int wait = Math.Max(1, interval - (int)Math.Min(interval - 1,
              offset + timer.Elapsed.TotalMilliseconds - elapsed));
            // Wake immediately when the target exits, including after the launcher exits.
            target.WaitForExit(wait);
          }
        }
      }
    } catch (Exception error) {
      if (accumulator != null && writer != null && writer.OwnsFiles) {
        string reason = error is MonitorFailure ? error.Message :
          error is ArgumentException ? "target-not-found" :
          error is System.ComponentModel.Win32Exception || error is UnauthorizedAccessException ? "permission-denied" :
          error is IOException ? "storage-error" : "monitor-error";
        try {
          DateTime ended = DateTime.UtcNow;
          writer.WriteSummary(accumulator.Summary(accumulator.SampleCount == 0 ? "unavailable" : "interrupted",
            ended, Math.Max(accumulator.LastElapsedMs, offset + timer.Elapsed.TotalMilliseconds), reason));
        } catch { /* A failed disk remains visible as stale; never replace game files. */ }
      }
      return 1;
    }
  }

  private static string NormalizePath(string value) {
    string result = Path.GetFullPath(value);
    if (result.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + result.Substring(8);
    if (result.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
    return result;
  }

  internal static void CheckDirectory(string directory) {
    for (DirectoryInfo current = new DirectoryInfo(directory); current != null; current = current.Parent) {
      if (!current.Exists || (current.Attributes & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Unsafe statistics directory.");
    }
  }

  private sealed class MonitorFailure : Exception {
    internal MonitorFailure(string code) : base(code) { }
  }

  internal sealed class SessionWriter {
    private readonly string directory;
    private readonly string id;
    internal bool OwnsFiles;
    internal SessionWriter(string directory, string id) { this.directory = directory; this.id = id; }
    internal void Initialize() {
      OwnsFiles = true;
      RewriteTrend(new List<TrendPoint>(), false);
    }
    private void CheckFile(string file) {
      CheckDirectory(directory);
      if (File.Exists(file)) CheckRegularFile(file);
    }
    private void AtomicText(string file, string content) {
      CheckFile(file);
      string temporary = Path.Combine(directory, ".write-" + Guid.NewGuid().ToString("N"));
      try {
        using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          byte[] bytes = Utf8.GetBytes(content);
          stream.Write(bytes, 0, bytes.Length);
          stream.Flush(true);
        }
        CheckFile(file);
        if (File.Exists(file)) File.Replace(temporary, file, null, true);
        else File.Move(temporary, file);
      } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private void RewriteTrend(IList<TrendPoint> samples, bool downsampled) {
      StringBuilder text = new StringBuilder();
      text.Append(Serializer().Serialize(new Dictionary<string, object> {
        { "schemaVersion", 1 }, { "id", id }, { "trendDownsampled", downsampled }
      })).Append('\n');
      foreach (TrendPoint sample in samples) text.Append(Serializer().Serialize(sample.ToDictionary())).Append('\n');
      AtomicText(Path.Combine(directory, "samples.jsonl"), text.ToString());
    }
    internal void WriteSample(PerformanceAccumulator accumulator, bool compacted) {
      if (compacted) { RewriteTrend(accumulator.Trend, true); return; }
      string file = Path.Combine(directory, "samples.jsonl");
      CheckFile(file);
      byte[] bytes = Utf8.GetBytes(Serializer().Serialize(accumulator.Trend[accumulator.Trend.Count - 1].ToDictionary()) + "\n");
      using (FileStream stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.Read)) {
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
      }
    }
    internal void WriteSummary(Dictionary<string, object> summary) {
      AtomicText(Path.Combine(directory, "summary.json"), Serializer().Serialize(summary) + "\n");
    }
  }
}

internal sealed class TrendPoint {
  internal double ElapsedMs;
  internal double? CpuPercent;
  internal double? MemoryBytes;
  internal double? PrivateMemoryBytes;
  internal double Count = 1, CpuCount, MemoryCount, PrivateCount;
  internal long SampleNumber;
  internal Dictionary<string, object> ToDictionary() {
    return new Dictionary<string, object> {
      { "elapsedMs", ElapsedMs }, { "cpuPercent", CpuPercent },
      { "memoryBytes", MemoryBytes }, { "privateMemoryBytes", PrivateMemoryBytes },
      { "sampleNumber", SampleNumber }
    };
  }
  private static double? Mean(double? a, double aw, double? b, double bw) {
    // A bin containing a missing measurement must remain a chart gap, even when
    // later compactions combine it with valid bins. Summary integrals are separate.
    if (!a.HasValue || !b.HasValue || aw + bw == 0) return null;
    return (a.Value * aw + b.Value * bw) / (aw + bw);
  }
  internal static TrendPoint Merge(TrendPoint a, TrendPoint b) {
    double? cpu = Mean(a.CpuPercent, a.CpuCount, b.CpuPercent, b.CpuCount);
    double? memory = Mean(a.MemoryBytes, a.MemoryCount, b.MemoryBytes, b.MemoryCount);
    double? privateMemory = Mean(a.PrivateMemoryBytes, a.PrivateCount, b.PrivateMemoryBytes, b.PrivateCount);
    return new TrendPoint {
      ElapsedMs = (a.ElapsedMs * a.Count + b.ElapsedMs * b.Count) / (a.Count + b.Count),
      CpuPercent = cpu, MemoryBytes = memory, PrivateMemoryBytes = privateMemory,
      Count = a.Count + b.Count, CpuCount = cpu.HasValue ? a.CpuCount + b.CpuCount : 0,
      MemoryCount = memory.HasValue ? a.MemoryCount + b.MemoryCount : 0,
      PrivateCount = privateMemory.HasValue ? a.PrivateCount + b.PrivateCount : 0,
      SampleNumber = b.SampleNumber
    };
  }
}

internal sealed class PerformanceAccumulator {
  private readonly Dictionary<string, object> initial;
  private readonly int cores, trendLimit;
  private double? previousCpu, previousMemory, previousPrivate;
  private double previousCpuAt, previousAt;
  private double cpuIntegral, cpuDuration, memoryIntegral, memoryDuration, privateIntegral, privateDuration;
  private double? cpuPeak, memoryPeak, privatePeak;
  private bool downsampled;
  private long gaps;
  internal long SampleCount;
  internal double LastElapsedMs;
  internal string LastSampleAt, ProcessStartedAt, ProcessStartTicks;
  internal List<TrendPoint> Trend = new List<TrendPoint>();

  internal PerformanceAccumulator(Dictionary<string, object> initial, int cores, int trendLimit) {
    this.initial = initial;
    this.cores = cores;
    this.trendLimit = trendLimit;
  }
  private static double? Peak(double? previous, double? value) {
    if (!value.HasValue) return previous;
    return previous.HasValue ? Math.Max(previous.Value, value.Value) : value;
  }
  internal bool Add(double elapsedMs, DateTime utc, double? cpuMs, long? memory, long? privateMemory, long? processPeak) {
    if (elapsedMs < 0 || (SampleCount > 0 && elapsedMs <= LastElapsedMs)) throw new ArgumentException("Non-monotonic sample.");
    double? cpuPercent = null;
    bool gap = !cpuMs.HasValue || !memory.HasValue || !privateMemory.HasValue;
    if (cpuMs.HasValue && previousCpu.HasValue && elapsedMs > previousCpuAt) {
      double delta = cpuMs.Value - previousCpu.Value;
      if (delta >= 0) {
        double duration = elapsedMs - previousCpuAt;
        cpuPercent = Math.Max(0, Math.Min(100, delta / duration / cores * 100));
        cpuIntegral += cpuPercent.Value * duration;
        cpuDuration += duration;
        cpuPeak = Peak(cpuPeak, cpuPercent);
      } else gap = true;
    }
    if (SampleCount > 0) {
      double duration = elapsedMs - previousAt;
      if (memory.HasValue && previousMemory.HasValue) {
        memoryIntegral += (memory.Value / 2.0 + previousMemory.Value / 2.0) * duration;
        memoryDuration += duration;
      }
      if (privateMemory.HasValue && previousPrivate.HasValue) {
        privateIntegral += (privateMemory.Value / 2.0 + previousPrivate.Value / 2.0) * duration;
        privateDuration += duration;
      }
    }
    if (cpuMs.HasValue) { previousCpu = cpuMs; previousCpuAt = elapsedMs; }
    previousMemory = memory.HasValue ? (double?)memory.Value : null;
    previousPrivate = privateMemory.HasValue ? (double?)privateMemory.Value : null;
    memoryPeak = Peak(memoryPeak, memory.HasValue ? (double?)memory.Value : null);
    memoryPeak = Peak(memoryPeak, processPeak.HasValue ? (double?)processPeak.Value : null);
    privatePeak = Peak(privatePeak, privateMemory.HasValue ? (double?)privateMemory.Value : null);
    if (gap) gaps++;
    SampleCount++;
    LastElapsedMs = elapsedMs;
    LastSampleAt = GamePerformanceMonitor.Iso(utc);
    previousAt = elapsedMs;
    Trend.Add(new TrendPoint {
      ElapsedMs = elapsedMs, CpuPercent = cpuPercent,
      MemoryBytes = memory.HasValue ? (double?)memory.Value : null,
      PrivateMemoryBytes = privateMemory.HasValue ? (double?)privateMemory.Value : null,
      CpuCount = cpuPercent.HasValue ? 1 : 0, MemoryCount = memory.HasValue ? 1 : 0,
      PrivateCount = privateMemory.HasValue ? 1 : 0, SampleNumber = SampleCount
    });
    if (Trend.Count <= trendLimit) return false;
    List<TrendPoint> compact = new List<TrendPoint>();
    compact.Add(Trend[0]);
    for (int i = 1; i < Trend.Count - 1; i += 2)
      compact.Add(i + 1 < Trend.Count - 1 ? TrendPoint.Merge(Trend[i], Trend[i + 1]) : Trend[i]);
    compact.Add(Trend[Trend.Count - 1]);
    Trend = compact;
    downsampled = true;
    return true;
  }
  internal Dictionary<string, object> Summary(string status, DateTime? endedAt, double durationMs, string reason) {
    Dictionary<string, object> result = new Dictionary<string, object>(initial);
    result["status"] = status;
    result["endedAt"] = endedAt.HasValue ? GamePerformanceMonitor.Iso(endedAt.Value) : null;
    result["lastSampleAt"] = LastSampleAt;
    result["durationMs"] = Math.Max(LastElapsedMs, durationMs);
    result["sampleCount"] = SampleCount;
    result["cpuAveragePercent"] = cpuDuration > 0 ? (double?)(cpuIntegral / cpuDuration) : null;
    result["cpuPeakPercent"] = cpuPeak;
    result["memoryAverageBytes"] = memoryDuration > 0 ? (double?)(memoryIntegral / memoryDuration) : null;
    result["memoryPeakBytes"] = memoryPeak;
    result["privateMemoryAverageBytes"] = privateDuration > 0 ? (double?)(privateIntegral / privateDuration) : null;
    result["privateMemoryPeakBytes"] = privatePeak;
    result["logicalCpuCount"] = cores;
    result["processStartedAt"] = ProcessStartedAt;
    result["processStartTicks"] = ProcessStartTicks;
    result["samplingGapCount"] = gaps;
    result["trendDownsampled"] = downsampled;
    result["failureReason"] = reason;
    return result;
  }
}
