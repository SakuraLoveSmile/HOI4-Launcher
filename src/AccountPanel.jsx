import { useI18n, T } from "./i18n.jsx";
import React, { useEffect, useState } from "react";
import { LogIn, LogOut, UserRound, ShieldCheck } from "lucide-react";
export default function AccountPanel({ api, perform, busy, Dialog }) {
  const { t, message, locale } = useI18n();
  const [account, setAccount] = useState(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getAccount()
      .then((value) => alive && setAccount(value))
      .catch(
        () =>
          alive &&
          setAccount({
            status: "signed-out",
            canRemember: false,
            notice: "无法读取账户状态，请重试。",
          }),
      );
    return () => {
      alive = false;
    };
  }, [api]);
  async function cancel() {
    try {
      await api.cancelLogin();
    } catch {
      setAccount((previous) => ({
        ...previous,
        notice: "取消登录时无法清除已保存的会话，请检查启动器数据目录权限。",
      }));
    } finally {
      setPassword("");
      setOpen(false);
    }
  }
  async function login(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await perform(
        "account-login",
        async () => {
          const result = await api.login({
            email: email.trim(),
            password,
            remember,
          });
          setAccount(result);
          setPassword("");
          setOpen(false);
          return result;
        },
        "已登录 Paradox 账户",
      );
    } finally {
      setPassword("");
      setSubmitting(false);
    }
  }
  return (
    <section className="panel settings-panel account-panel">
      <div className="section-heading">
        <h2>
          <UserRound size={18} />
          <T id={"Paradox 账户"} />
        </h2>
        <span className="status-chip">
          {account?.status === "signed-in" ? t("已登录") : t("未登录")}
        </span>
      </div>
      {account?.status === "signed-in" ? (
        <>
          <p className="section-description">
            {account.account.displayName || account.account.email}
          </p>
          <div className="settings-actions">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() =>
                perform(
                  "account-logout",
                  async () => {
                    const result = await api.logout();
                    setAccount(result);
                    return result;
                  },
                  "已退出 Paradox 账户",
                )
              }
            >
              <LogOut size={15} />
              <T id={"退出账户"} />
            </button>
            <span className="account-storage">
              {account.remembered
                ? t("已在此设备加密保存登录状态")
                : t("仅在本次运行中保持登录")}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="section-description">
            <T
              id={
                "连接自己的 Paradox 账户。管理本地模组和启动 Steam 游戏无需登录。"
              }
            />
          </p>
          <button
            className="button subtle"
            disabled={busy || !account}
            onClick={() => setOpen(true)}
          >
            <LogIn size={15} />
            <T id={"登录 Paradox 账户"} />
          </button>
        </>
      )}
      {account?.notice && (
        <p className="inline-note" role="status">
          {message(account.notice)}
        </p>
      )}
      {open && (
        <Dialog title={t("登录 Paradox 账户")} onClose={cancel}>
          <form onSubmit={login}>
            <p className="modal-description">
              <T
                id={
                  "登录资料通过加密连接发送至 Paradox。密码仅用于本次登录，不保存到磁盘。"
                }
              />
            </p>
            <div className="authoring-fields">
              <label>
                <T id={"电子邮箱"} />
                <input
                  type="email"
                  aria-label={t("Paradox 电子邮箱")}
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={submitting}
                  maxLength={254}
                />
              </label>
              <label>
                <T id={"密码"} />
                <input
                  type="password"
                  aria-label={t("Paradox 密码")}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting}
                  maxLength={1024}
                />
              </label>
              <label className="account-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  disabled={submitting || !account?.canRemember}
                />
                <span>
                  <T id={"在此设备保持登录"} />
                  <small>
                    {account?.canRemember
                      ? t("会话由 Windows 系统加密保护")
                      : t("当前无法使用系统加密，仅支持本次运行登录")}
                  </small>
                </span>
              </label>
            </div>
            <div className="modal-actions">
              <button className="button subtle" type="button" onClick={cancel}>
                <T id={"取消"} />
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={submitting || !email.trim() || !password}
              >
                <ShieldCheck size={15} />
                {submitting ? t("正在登录…") : t("登录")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
