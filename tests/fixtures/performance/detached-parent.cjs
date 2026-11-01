"use strict";

const { createGamePerformanceService } = require(process.argv[2]);
const service = createGamePerformanceService({
  storageDirectory: process.argv[3],
  monitorPath: process.argv[4],
  sampleIntervalMs: 250,
});
service
  .startSession({
    pid: Number(process.argv[5]),
    launchedAt: process.argv[6],
    executable: process.argv[7],
    gameVersion: "1.19.4.0",
    instanceId: "default",
    instanceName: "隔离实例",
    playsetId: "fixture",
    playsetName: "独立进程",
    modCount: 3,
    launchMode: "normal",
  })
  .then((session) => process.stdout.write(JSON.stringify(session) + "\n"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
