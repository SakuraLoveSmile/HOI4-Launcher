import { useI18n, T } from "./i18n.jsx";
import React, { useState } from "react";
import { Cloud, Download, RefreshCw } from "lucide-react";
export default function PdxSubscriptions({
  api,
  subscriptions,
  setSubscriptions,
  perform,
  busy,
  state,
  Dialog,
  start,
  downloading,
}) {
  const { t, message, locale } = useI18n();
  const [remove, setRemove] = useState(null);
  const titleOf = (item) =>
    item.titleIsFallback
      ? t("Paradox 模组 {0}", { 0: item.modId })
      : item.title;
  return (
    <section className="panel pdx-downloads">
      <div className="section-heading">
        <h2>
          <Cloud size={18} />
          <T id={"Paradox 账号订阅"} />
        </h2>
        <button
          className="button subtle"
          disabled={busy || subscriptions.loading}
          onClick={() =>
            perform("pdx-subscriptions", async () =>
              setSubscriptions(
                await api.getPdxSubscriptions({
                  refresh: true,
                }),
              ),
            )
          }
        >
          <RefreshCw size={14} />
          <T id={"刷新订阅"} />
        </button>
      </div>
      <p className="section-description">
        {subscriptions.loading
          ? t("正在读取订阅…")
          : subscriptions.accountId
            ? t(
                "账号订阅与本地安装分别管理。取消订阅不会删除本地内容或预设引用。",
              )
            : t(
                "在设置页主动登录 Paradox 账号后，可同步和管理订阅。公开模组也可直接下载。",
              )}
      </p>
      {subscriptions.error && (
        <p className="inline-note" role="status">
          {message(subscriptions.error.message)}
        </p>
      )}
      {subscriptions.accountId &&
        !subscriptions.error &&
        !subscriptions.items.length && (
          <p className="section-description">
            <T
              id={"此账号还没有 HOI4 模组订阅。可从下方作品选择“订阅到账号”。"}
            />
          </p>
        )}
      {subscriptions.items.map((item) => (
        <div className="pdx-installed-row" key={item.modId}>
          <div>
            <strong>{titleOf(item)}</strong>
            <small>
              {item.revision
                ? t("固定版本 {0}", {
                    0: item.revision,
                  })
                : t("跟随最新版本")}
            </small>
          </div>
          <div>
            <button
              className="button subtle"
              disabled={busy || downloading || state.launchStatus?.running}
              onClick={() => start(item.modId, item.revision)}
            >
              <Download size={14} />
              <T id={"下载订阅内容"} />
            </button>
            <button
              className="text-button"
              disabled={
                busy ||
                Boolean(subscriptions.error) ||
                state.launchStatus?.running
              }
              onClick={() => setRemove(item)}
            >
              <T id={"取消订阅"} />
            </button>
          </div>
        </div>
      ))}
      {remove && (
        <Dialog
          title={t("取消 Paradox 订阅")}
          onClose={() => !busy && setRemove(null)}
        >
          <p>
            <T
              id={"取消账号对“{0}”的订阅。本地安装和预设引用会保留。"}
              values={[titleOf(remove)]}
            />
          </p>
          <div className="dialog-actions">
            <button className="button subtle" onClick={() => setRemove(null)}>
              <T id={"返回"} />
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                perform("pdx-unsubscribe", async () => {
                  setSubscriptions(await api.unsubscribePdxMod(remove.modId));
                  setRemove(null);
                })
              }
            >
              <T id={"确认取消订阅"} />
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
