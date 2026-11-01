import React, {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  languages,
  availableLanguage,
  translate,
  translatedTemplate,
  translateMessage,
  formatDiagnostic,
} from "./i18n-core.mjs";
const Context = createContext(null);
const token = /\{(\d+)\}/g;
export function I18nProvider({ children }) {
  const [language, setLanguage] = useState("zh-hans");
  const effective = availableLanguage(language);
  const context = useMemo(() => {
    const locale = languages.find((item) => item.id === effective).locale;
    return {
      language: effective,
      requestedLanguage: language,
      locale,
      setLanguage,
      t: (key, values) => translate(effective, key, values),
      message: (value, fallback) =>
        value && typeof value === "object"
          ? formatDiagnostic(effective, value, fallback ?? "")
          : translateMessage(effective, value ?? fallback),
      date: (value) => new Intl.DateTimeFormat(locale).format(new Date(value)),
    };
  }, [effective, language]);
  useEffect(() => {
    document.documentElement.lang = context.locale;
    document.title = context.t("IRONCLAD · 钢铁雄心 IV 启动器");
  }, [context]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function useI18n() {
  const context = useContext(Context);
  if (!context) throw new Error("I18nProvider is required");
  return context;
}

// Rich values remain React nodes. Translation cannot turn user data into HTML
// or alter a mod/playset name that happens to match an interface label.
export function T({ id, values = [] }) {
  const { language } = useI18n();
  const translated = translatedTemplate(language, id),
    result = [];
  let start = 0;
  for (const match of translated.matchAll(token)) {
    result.push(translated.slice(start, match.index));
    result.push(
      <Fragment key={`${match.index}:${match[1]}`}>
        {values[Number(match[1])]}
      </Fragment>,
    );
    start = match.index + match[0].length;
  }
  result.push(translated.slice(start));
  return <>{result}</>;
}
export function LanguagePanel({ settings, persist, busy }) {
  const { t, language, requestedLanguage } = useI18n();
  return (
    <section className="panel settings-panel language-panel">
      <div className="section-heading">
        <h2>{t("启动器语言")}</h2>
      </div>
      <p className="section-description">
        {t("只改变启动器界面，不修改游戏语言、模组名称或预设内容。")}
      </p>
      <label className="game-option">
        <span>{t("界面语言")}</span>
        <select
          aria-label={t("界面语言")}
          value={language}
          disabled={busy}
          onChange={(event) =>
            persist(
              {
                launcherPreferences: {
                  ...settings.launcherPreferences,
                  language: event.target.value,
                },
              },
              "界面语言已保存",
            )
          }
        >
          {languages.map((item) => (
            <option value={item.id} key={item.id} lang={item.locale}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {language !== requestedLanguage && (
        <p role="status" className="inline-note">
          {t("所选语言暂不可用，当前显示英语。")}
        </p>
      )}
    </section>
  );
}
