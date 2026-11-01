import React, { useEffect, useRef, useState } from "react";
import { Activity, Clock3, Cpu, MemoryStick, RefreshCw } from "lucide-react";
import { useI18n } from "./i18n.jsx";
import { EnvironmentChanges } from "./Campaigns.jsx";
import "./performance.css";

const statusKeys = {
  recording: "正在记录",
  completed: "已结束",
  interrupted: "记录中断",
  unavailable: "采集不可用",
  stale: "暂未更新",
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const duration = (value) => {
  if (!finite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

function PerformanceChart({ session, comparison, kind }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState(null);
  const records = comparison ? [session, comparison] : [session];
  const memory = kind === "memory";
  const lines = memory ? ["memoryBytes", "privateMemoryBytes"] : ["cpuPercent"];
  const width = 760,
    height = 210,
    left = 58,
    right = 16,
    top = 16,
    bottom = 30;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const end = Math.max(
    1,
    ...records.flatMap((record) => [
      record.durationMs || 0,
      ...(record.samples || []).map((point) => point.elapsedMs || 0),
    ]),
  );
  const values = records
    .flatMap((record) => record.samples || [])
    .flatMap((point) => lines.map((key) => point[key]))
    .filter(finite);
  const available = values.length > 0;
  const maximum = memory ? Math.max(1024 ** 3, ...values) * 1.12 : 100;
  const number = (value, digits = 1) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(
      value,
    );
  const bytes = (value) =>
    !finite(value) ? "—" : `${number(value / 1024 ** 3, 2)} GiB`;
  const x = (value) => left + (value / end) * plotWidth;
  const y = (value) =>
    top + (1 - Math.max(0, Math.min(maximum, value)) / maximum) * plotHeight;
  const paths = (record, key) => {
    const segments = [];
    let segment = [];
    for (const point of record.samples || []) {
      if (finite(point[key]) && finite(point.elapsedMs)) {
        segment.push(`${x(point.elapsedMs)},${y(point[key])}`);
      } else if (segment.length) {
        segments.push(segment.join(" "));
        segment = [];
      }
    }
    if (segment.length) segments.push(segment.join(" "));
    return segments;
  };
  const inspect = (event) => {
    if (!records.some((record) => record.samples?.length)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const location =
      ((((event.clientX - bounds.left) / bounds.width) * width - left) /
        plotWidth) *
      end;
    const points = records.map((record) => {
      const points = record.samples || [];
      if (
        !points.length ||
        location < 0 ||
        location > (record.durationMs || points.at(-1).elapsedMs)
      )
        return null;
      return points.reduce((nearest, point) =>
        Math.abs(point.elapsedMs - location) <
        Math.abs(nearest.elapsedMs - location)
          ? point
          : nearest,
      );
    });
    setHover({
      elapsedMs: comparison
        ? Math.max(0, Math.min(end, location))
        : (points[0]?.elapsedMs ?? location),
      points,
    });
  };
  useEffect(() => setHover(null), [session.id, comparison?.id, kind]);
  const title = t(memory ? "内存占用趋势" : "CPU 使用率趋势");

  return (
    <section className="panel performance-chart" aria-label={title}>
      <div className="section-heading">
        <h2>
          {memory ? <MemoryStick size={18} /> : <Cpu size={18} />}
          {title}
        </h2>
        <span>{memory ? "GiB" : t("占整机 CPU")}</span>
      </div>
      {available ? (
        <div className="performance-plot">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={title}
            onPointerMove={inspect}
            onPointerLeave={() => setHover(null)}
          >
            <title>{title}</title>
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
              <g key={ratio}>
                <line
                  x1={left}
                  x2={width - right}
                  y1={y(maximum * ratio)}
                  y2={y(maximum * ratio)}
                  className="performance-grid"
                />
                <text x={left - 9} y={y(maximum * ratio) + 4} textAnchor="end">
                  {number(
                    memory ? (maximum * ratio) / 1024 ** 3 : maximum * ratio,
                  )}
                  {memory ? "" : "%"}
                </text>
              </g>
            ))}
            {[0, 0.5, 1].map((ratio) => (
              <text
                key={ratio}
                x={x(end * ratio)}
                y={height - 7}
                textAnchor={
                  ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"
                }
              >
                {duration(end * ratio)}
              </text>
            ))}
            {records.flatMap((record, series) =>
              lines.map((key, index) =>
                paths(record, key).map((points, part) => (
                  <polyline
                    key={`${record.id}-${key}-${part}`}
                    points={points}
                    className={`performance-line ${index ? "secondary" : ""} ${series ? "comparison" : ""}`}
                  />
                )),
              ),
            )}
            {hover && (
              <line
                x1={x(hover.elapsedMs)}
                x2={x(hover.elapsedMs)}
                y1={top}
                y2={height - bottom}
                className="performance-cursor"
              />
            )}
          </svg>
          {hover && (
            <div className="performance-inspection" role="status">
              {!comparison && <strong>{duration(hover.elapsedMs)}</strong>}
              {hover.points.map((point, index) => (
                <div className="performance-inspection-record" key={index}>
                  {comparison && (
                    <strong>
                      {index ? "B" : "A"} ·{" "}
                      {point ? duration(point.elapsedMs) : "—"}
                    </strong>
                  )}
                  {!point ? (
                    <span>{t("该时段无采样")}</span>
                  ) : memory ? (
                    <>
                      <span>
                        {t("物理内存")} {bytes(point.memoryBytes)}
                      </span>
                      <span>
                        {t("私有提交内存")} {bytes(point.privateMemoryBytes)}
                      </span>
                    </>
                  ) : (
                    <span>
                      {finite(point.cpuPercent)
                        ? `${number(point.cpuPercent)}%`
                        : t("暂无有效采样")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="performance-no-samples">{t("暂无有效采样")}</div>
      )}
      <div className="performance-legend">
        <span>
          <i />
          {comparison && "A · "}
          {t(memory ? "物理内存" : "占整机 CPU")}
        </span>
        {memory && (
          <span>
            <i className="secondary" />
            {comparison && "A · "}
            {t("私有提交内存")}
          </span>
        )}
        {comparison && (
          <>
            <span>
              <i className="comparison" />B ·{" "}
              {t(memory ? "物理内存" : "占整机 CPU")}
            </span>
            {memory && (
              <span>
                <i className="comparison secondary" />B · {t("私有提交内存")}
              </span>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SessionNotes({ session, busy, onSave }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(session.notes || "");
  const previous = useRef({ id: session.id, value: session.notes || "" });
  useEffect(() => {
    const value = session.notes || "";
    if (previous.current.id !== session.id || draft === previous.current.value)
      setDraft(value);
    previous.current = { id: session.id, value };
  }, [session.id, session.notes]);
  return (
    <section className="panel performance-notes">
      <label>
        <span>{t("本次游玩备注")}</span>
        <textarea
          aria-label={t("本次游玩备注")}
          maxLength={4000}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
        />
      </label>
      <button
        className="button subtle"
        disabled={busy || draft === (session.notes || "")}
        onClick={() => onSave(session.id, draft)}
      >
        {t("保存游玩备注")}
      </button>
    </section>
  );
}

function SessionComparison({
  session,
  comparison,
  result,
  number,
  bytes,
  formatTime,
}) {
  const { t, message } = useI18n();
  const rows = [
    ["游玩时长", "durationMs", duration, "duration"],
    [
      "平均 CPU 使用率",
      "cpuAveragePercent",
      (v) => (finite(v) ? `${number(v)}%` : "—"),
      "cpu",
    ],
    [
      "CPU 峰值",
      "cpuPeakPercent",
      (v) => (finite(v) ? `${number(v)}%` : "—"),
      "cpu",
    ],
    ["平均物理内存", "memoryAverageBytes", bytes, "memory"],
    ["物理内存峰值", "memoryPeakBytes", bytes, "memory"],
    ["平均私有提交内存", "privateMemoryAverageBytes", bytes, "memory"],
    ["私有提交内存峰值", "privateMemoryPeakBytes", bytes, "memory"],
  ];
  const delta = (a, b, kind) => {
    if (!finite(a) || !finite(b)) return "—";
    const difference = b - a,
      sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
    const absolute = Math.abs(difference);
    if (kind === "cpu")
      return sign + t("{0} 个百分点", { 0: number(absolute) });
    return sign + (kind === "memory" ? bytes(absolute) : duration(absolute));
  };
  return (
    <section
      className="panel performance-comparison"
      aria-label={t("两次游玩对比")}
    >
      <h2>{t("两次游玩对比")}</h2>
      <p className="section-description">
        A · {session.playsetName} · {formatTime(session.startedAt)}
        <br />B · {comparison.playsetName} · {formatTime(comparison.startedAt)}
      </p>
      <p className="performance-hint">
        {t(
          "曲线按启动后经过时间对齐。占用差异不能代表游戏日期推进速度；不同战役阶段和硬件也会影响结果。",
        )}
      </p>
      <div className="performance-comparison-table">
        <table>
          <thead>
            <tr>
              <th>{t("指标")}</th>
              <th>{t("记录 A")}</th>
              <th>{t("记录 B")}</th>
              <th>{t("B − A")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, key, format, kind]) => (
              <tr key={key}>
                <th>{t(label)}</th>
                <td>{format(session[key])}</td>
                <td>{format(comparison[key])}</td>
                <td>{delta(session[key], comparison[key], kind)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.notes && (
        <p className="performance-comparison-note">
          <strong>{t("记录 B 备注")}</strong>
          {comparison.notes}
        </p>
      )}
      <h3>{t("两次启动配置差异")}</h3>
      {result?.available ? (
        <EnvironmentChanges
          changes={result.changes}
          emptyKey="记录的配置元数据一致。"
        />
      ) : (
        <p className="inline-note">
          {result?.notice
            ? message(result.notice)
            : t("此统计记录未保存完整启动配置，无法比较配置。")}
        </p>
      )}
      <p className="performance-hint">
        {t(
          "普通启动只记录配置元数据，不额外扫描全部 Mod 文件；未核验内容会明确标记。",
        )}
      </p>
    </section>
  );
}

export default function GamePerformance({
  api,
  perform,
  busy,
  preview = false,
}) {
  const { t, message, locale } = useI18n();
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [session, setSession] = useState(null);
  const [comparisonId, setComparisonId] = useState("");
  const [comparison, setComparison] = useState(null),
    [comparisonResult, setComparisonResult] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const selected = useRef("");
  const compared = useRef("");
  const generation = useRef(0);
  const changingRef = useRef(false);
  const mounted = useRef(false);
  const capable = typeof api.getGamePerformance === "function";
  selected.current = selectedId;
  compared.current = comparisonId;

  async function refresh(id, compareId) {
    const request = ++generation.current;
    try {
      const next = await api.getGamePerformance();
      if (!mounted.current || request !== generation.current) return;
      setData(next);
      const desired = id ?? selected.current;
      const target =
        next.sessions.find((item) => item.id === desired)?.id ||
        next.sessions[0]?.id ||
        "";
      selected.current = target;
      setSelectedId(target);
      const detail = target
        ? await api.getGamePerformanceSession(target)
        : null;
      if (!mounted.current || request !== generation.current) return;
      const desiredComparison = compareId ?? compared.current;
      const compareTarget =
        next.sessions.find(
          (item) => item.id === desiredComparison && item.id !== target,
        )?.id || "";
      compared.current = compareTarget;
      setComparisonId(compareTarget);
      const other = compareTarget
        ? await api.getGamePerformanceSession(compareTarget)
        : null;
      const differences =
        compareTarget && target && api.compareGamePerformance
          ? await api.compareGamePerformance(target, compareTarget)
          : null;
      if (!mounted.current || request !== generation.current) return;
      setSession(detail);
      setComparison(other);
      setComparisonResult(differences);
      setError(false);
    } catch {
      if (mounted.current && request === generation.current) setError(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (capable) refresh();
    else setLoading(false);
    const timer = setInterval(() => {
      if (capable && !document.hidden && !changingRef.current) refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [api]);

  const formatTime = (value) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "—";
  const number = (value, digits = 1) =>
    finite(value)
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(
          value,
        )
      : "—";
  const percent = (value) => (finite(value) ? `${number(value)}%` : "—");
  const bytes = (value) =>
    finite(value) ? `${number(value / 1024 ** 3, 2)} GiB` : "—";
  const status = (value) => t(statusKeys[value] || "记录中断");
  const toggle = () =>
    perform("game-performance", async () => {
      changingRef.current = true;
      generation.current++;
      setChanging(true);
      try {
        const next = await api.setGamePerformanceEnabled(!data.enabled);
        if (mounted.current) setData(next);
        return next;
      } finally {
        changingRef.current = false;
        if (mounted.current) setChanging(false);
      }
    });
  const saveNotes = (id, notes) =>
    perform("performance-notes", async () => {
      changingRef.current = true;
      generation.current++;
      setChanging(true);
      try {
        const result = await api.setGamePerformanceNotes(id, notes);
        if (mounted.current && selected.current === id) setSession(result);
        return result;
      } finally {
        changingRef.current = false;
        if (mounted.current) setChanging(false);
      }
    });

  return (
    <div className="performance-workspace">
      <section className="panel performance-intro">
        <div className="performance-intro-copy">
          <div className="section-heading">
            <h2>
              <Activity size={19} />
              {t("整段游玩性能")}
            </h2>
          </div>
          <p className="section-description">
            {t(
              "自动记录本启动器启动的游戏；关闭启动器后仍会继续采集，退出游戏后结束。",
            )}
          </p>
          <p className="performance-hint">
            {t(
              "当前记录 CPU、内存和运行时长；FPS 与游戏日期推进速度尚未采集。",
            )}
          </p>
        </div>
        <div className="performance-controls">
          <label className="performance-toggle">
            <span>{t("自动记录后续游戏")}</span>
            <button
              type="button"
              role="switch"
              aria-label={t("自动记录后续游戏")}
              aria-checked={!!data?.enabled}
              className={`toggle ${data?.enabled ? "on" : ""}`}
              disabled={busy || changing || !data?.supported || !capable}
              onClick={toggle}
            >
              <span />
            </button>
          </label>
          <span className="performance-hint">
            {t("开关仅影响之后启动的游戏。")}
          </span>
        </div>
      </section>
      {preview && (
        <p className="performance-hint" role="note">
          {t("预览使用示例统计，不会采集本机进程。")}
        </p>
      )}
      {!capable && (
        <p className="inline-note">
          {t("请在桌面启动器中查看和记录游戏性能。")}
        </p>
      )}
      {data && !data.supported && (
        <p className="inline-note">{t("此系统暂不支持游戏性能采集。")}</p>
      )}
      {data?.notice && (
        <p className="inline-note" role="status">
          {message(data.notice)}
        </p>
      )}
      {error && (
        <p className="inline-note" role="alert">
          {t("无法读取游戏统计，请重试。")}
        </p>
      )}
      <div className="performance-toolbar">
        <label>
          <span>{t("选择游玩记录")}</span>
          <select
            aria-label={t("选择游玩记录")}
            value={selectedId}
            disabled={!data?.sessions.length || changing}
            onChange={(event) => {
              setSelectedId(event.target.value);
              selected.current = event.target.value;
              setSession(null);
              setComparison(null);
              setComparisonResult(null);
              refresh(event.target.value);
            }}
          >
            {!data?.sessions.length && (
              <option value="">{t("暂无游玩记录")}</option>
            )}
            {data?.sessions.map((item) => (
              <option value={item.id} key={item.id}>
                {formatTime(item.startedAt)} · {item.playsetName} ·{" "}
                {status(item.status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("对比另一条记录")}</span>
          <select
            aria-label={t("对比另一条记录")}
            value={comparisonId}
            disabled={changing || !data?.sessions.length}
            onChange={(event) => {
              const id = event.target.value;
              setComparisonId(id);
              compared.current = id;
              setComparison(null);
              setComparisonResult(null);
              refresh(selected.current, id);
            }}
          >
            <option value="">{t("不进行对比")}</option>
            {data?.sessions
              .filter((item) => item.id !== selectedId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {formatTime(item.startedAt)} · {item.playsetName}
                </option>
              ))}
          </select>
        </label>
        <button
          className="button subtle"
          disabled={loading || changing || !capable}
          onClick={() => refresh()}
        >
          <RefreshCw size={15} />
          {t("刷新统计")}
        </button>
      </div>
      {loading && (
        <div className="performance-empty" role="status">
          {t("正在读取游戏统计…")}
        </div>
      )}
      {!loading && data && !data.sessions.length && (
        <section className="panel performance-empty">
          <Activity size={30} />
          <h2>{t("暂无游玩记录")}</h2>
          <p>
            {t("启用自动记录后，从此启动器启动下一次游戏，统计会出现在这里。")}
          </p>
        </section>
      )}
      {session && (
        <>
          <section
            className="panel performance-session"
            aria-label={t("游玩记录摘要")}
          >
            <div>
              <span className={`performance-status ${session.status}`}>
                {status(session.status)}
              </span>
              <h2>{session.playsetName}</h2>
              <p>
                {session.instanceName} · {session.gameVersion || t("未识别")} ·{" "}
                {t("{0} 个已启用模组", { 0: number(session.modCount, 0) })}
              </p>
            </div>
            <dl>
              <div>
                <dt>{t("开始时间")}</dt>
                <dd>{formatTime(session.startedAt)}</dd>
              </div>
              <div>
                <dt>{t("结束时间")}</dt>
                <dd>
                  {session.status === "recording"
                    ? t("游戏运行中")
                    : formatTime(session.endedAt)}
                </dd>
              </div>
            </dl>
          </section>
          <div className="performance-metrics">
            <div className="panel performance-metric">
              <span>
                <Clock3 size={16} />
                {t("游玩时长")}
              </span>
              <strong>{duration(session.durationMs)}</strong>
              <small>{status(session.status)}</small>
            </div>
            <div className="panel performance-metric">
              <span>
                <Cpu size={16} />
                {t("平均 CPU 使用率")}
              </span>
              <strong>{percent(session.cpuAveragePercent)}</strong>
              <small>
                {t("峰值 {0}", { 0: percent(session.cpuPeakPercent) })}
              </small>
            </div>
            <div className="panel performance-metric">
              <span>
                <MemoryStick size={16} />
                {t("物理内存峰值")}
              </span>
              <strong>{bytes(session.memoryPeakBytes)}</strong>
              <small>
                {t("平均 {0}", { 0: bytes(session.memoryAverageBytes) })}
              </small>
            </div>
            <div className="panel performance-metric">
              <span>
                <Activity size={16} />
                {t("采样次数")}
              </span>
              <strong>{number(session.sampleCount, 0)}</strong>
              <small>
                {t("每 {0} 秒采样", {
                  0: number((data?.intervalMs || 5000) / 1000, 0),
                })}
              </small>
            </div>
          </div>
          {(session.samplingGapCount > 0 ||
            session.status === "unavailable" ||
            session.status === "interrupted" ||
            session.status === "stale") && (
            <p className="inline-note" role="status">
              {t("记录存在缺口或采集已停止；缺失区间不会被当作零占用。")}
            </p>
          )}
          {session.contextNotice && (
            <p className="inline-note" role="status">
              {session.contextNotice.split("\n").map((notice, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <br />}
                  {message(notice)}
                </React.Fragment>
              ))}
            </p>
          )}
          {api.setGamePerformanceNotes && (
            <SessionNotes
              session={session}
              busy={busy || changing}
              onSave={saveNotes}
            />
          )}
          {comparison && (
            <SessionComparison
              session={session}
              comparison={comparison}
              result={comparisonResult}
              number={number}
              bytes={bytes}
              formatTime={formatTime}
            />
          )}
          {comparison?.contextNotice && (
            <p className="inline-note">
              {comparison.contextNotice.split("\n").map((notice, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <br />}
                  {message(notice)}
                </React.Fragment>
              ))}
            </p>
          )}
          <PerformanceChart
            session={session}
            comparison={comparison}
            kind="cpu"
          />
          <PerformanceChart
            session={session}
            comparison={comparison}
            kind="memory"
          />
          <div className="performance-footnotes">
            <p>
              {t(
                "CPU 按整机的 {0} 个逻辑处理器归一；平均值按有效采样时间计算。",
                { 0: number(session.logicalCpuCount, 0) },
              )}
            </p>
            <p>
              {t(
                "内存曲线分别表示驻留物理内存与进程私有提交量，不是整机内存占用。",
              )}
            </p>
            {session.trendDownsampled && (
              <p>
                {t(
                  "长记录趋势已合并采样点；摘要仍保留全程统计与峰值，缺测不会补零。",
                )}
              </p>
            )}
            <p>{t("显示最近 100 次游玩记录，历史文件保留在本机。")}</p>
          </div>
        </>
      )}
    </div>
  );
}
