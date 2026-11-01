using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

internal static class PerformanceMonitorReplayFixture {
  private static int Main(string[] args) {
    string directory = Path.GetFullPath(args[0]);
    string scenario = args[1];
    var serializer = GamePerformanceMonitor.Serializer();
    var configuration = serializer.Deserialize<Dictionary<string, object>>(
      File.ReadAllText(Path.Combine(directory, "session.json"), Encoding.UTF8));
    var initial = (Dictionary<string, object>)configuration["session"];
    DateTime origin = DateTime.Parse((string)initial["startedAt"], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    var accumulator = new PerformanceAccumulator(initial, 4, 2400);
    if (scenario == "long" || scenario == "long-gap") {
      double cpu = 0;
      for (int i = 0; i <= 10000; i++) {
        cpu += i == 2000 ? 19000 : 500;
        if (scenario == "long-gap" && i == 1234)
          accumulator.Add(1000 + i * 5000, origin.AddMilliseconds(1000 + i * 5000), null, null, null, null);
        else accumulator.Add(1000 + i * 5000, origin.AddMilliseconds(1000 + i * 5000), cpu,
          i == 4333 ? 999999 : 1000 + i, i == 6666 ? 500000 : 100, null);
      }
    } else {
      accumulator.Add(1000, origin.AddMilliseconds(1000), 100, 100, 50, 140);
      if (scenario != "first") {
        accumulator.Add(2000, origin.AddMilliseconds(2000), 1100, 300, 150, 350);
        accumulator.Add(5000, origin.AddMilliseconds(5000), 7100, 500, 250, 900);
      }
      if (scenario == "gap") accumulator.Add(6000, origin.AddMilliseconds(6000), null, null, 250, null);
    }
    StringBuilder trend = new StringBuilder();
    trend.Append(serializer.Serialize(new Dictionary<string, object> {
      { "schemaVersion", 1 }, { "id", initial["id"] },
      { "trendDownsampled", scenario == "long" || scenario == "long-gap" }
    })).Append('\n');
    foreach (TrendPoint point in accumulator.Trend) trend.Append(serializer.Serialize(point.ToDictionary())).Append('\n');
    File.WriteAllText(Path.Combine(directory, "samples.jsonl"), trend.ToString(), new UTF8Encoding(false));
    var writer = new GamePerformanceMonitor.SessionWriter(directory, (string)initial["id"]);
    writer.WriteSummary(accumulator.Summary("completed", origin.AddMilliseconds(accumulator.LastElapsedMs),
      accumulator.LastElapsedMs, null));
    Console.WriteLine(serializer.Serialize(new { points = accumulator.Trend.Count, samples = accumulator.SampleCount }));
    return 0;
  }
}
