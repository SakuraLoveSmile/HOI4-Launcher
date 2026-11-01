import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

// Independent, headless browser profile. Never attaches to a user's open browser.
const output = resolve("test-results");
await mkdir(output, { recursive: true });
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1"],
  {
    cwd: resolve("."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout.on("data", (data) => {
  serverLog += data;
});
server.stderr.on("data", (data) => {
  serverLog += data;
});
let browser;
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
};
try {
  const deadline = Date.now() + 15000;
  while (!serverLog.includes("127.0.0.1:4173")) {
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(`Preview server failed: ${serverLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    channel: process.env.TEST_BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1320, height: 940 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4173");
  await page.getByRole("heading", { name: /历史的下一页/ }).waitFor();
  check(
    await page.getByText("界面预览 · 示例数据").isVisible(),
    "browser preview clearly marks sample data",
  );
  await page.screenshot({
    path: resolve(output, "overview.png"),
    fullPage: true,
  });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "desktop layout has no horizontal overflow",
  );

  await page.getByRole("button", { name: "模组管理" }).click();
  const switchRoad = page.getByRole("switch", {
    name: "停用 The Road to 56",
    exact: true,
  });
  await switchRoad.click();
  await page
    .getByRole("switch", { name: "启用 The Road to 56", exact: true })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "模组管理" }).click();
  check(
    (await page
      .getByRole("switch", { name: "启用 The Road to 56", exact: true })
      .getAttribute("aria-checked")) === "false",
    "mod selection persists across reloads",
  );
  await page.getByRole("button", { name: "本地", exact: true }).click();
  check(
    (await page.locator(".playset-library .mod-row").count()) === 1,
    "source filter shows only local mods",
  );
  await page
    .getByRole("button", { name: "My Radio Collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "发布到 Paradox Mods", exact: true })
    .click();
  await page.getByRole("dialog", { name: "发布到 Paradox Mods" }).waitFor();
  check(
    await page
      .getByRole("button", { name: "准备并检查内容", exact: true })
      .isDisabled(),
    "signed-out Paradox publication cannot prepare or upload",
  );
  check(
    (await page.getByLabel("Paradox 发布简介", { exact: true }).isVisible()) &&
      (await page
        .getByLabel("Paradox 推荐游戏版本", { exact: true })
        .isVisible()),
    "Paradox publication exposes official summary and version fields",
  );
  check(
    await page
      .getByText("按 Paradox 服务端默认可见性提交，发布后请核对来源页。", {
        exact: true,
      })
      .isVisible(),
    "publication explains actual provider visibility behavior",
  );
  await page.screenshot({
    path: resolve(output, "pdx-publish-signed-out.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "前往账号设置", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    await page
      .getByRole("button", { name: "登录 Paradox 账户", exact: true })
      .isVisible(),
    "publication leads directly to account settings",
  );
  await page.getByText("界面预览 · 默认模组目录", { exact: true }).waitFor();
  check(
    await page
      .getByRole("button", { name: "恢复默认位置", exact: true })
      .isDisabled(),
    "default PDX storage cannot request a redundant reset",
  );
  await page.getByRole("button", { name: "选择模组位置", exact: true }).click();
  await page
    .getByText("请在桌面版中选择和迁移模组目录。", { exact: true })
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "选择模组位置", exact: true })
      .isEnabled(),
    "preview storage entry explains desktop requirement without mutating data",
  );
  await page.getByRole("button", { name: "模组管理" }).click();
  await page.getByRole("button", { name: "全部模组" }).click();
  await page.getByRole("textbox", { name: "搜索模组" }).fill("state");
  check(
    (await page.locator(".playset-library .mod-row").count()) === 1,
    "mod search filters results",
  );
  await page.getByRole("textbox", { name: "搜索模组" }).fill("no-such-mod");
  check(
    await page.getByText("没有找到匹配的模组").isVisible(),
    "search empty state is useful",
  );
  await page.getByRole("button", { name: "清空搜索" }).click();

  await page.getByRole("button", { name: "新建播放集" }).click();
  const name = page.getByRole("textbox", { name: "播放集名称" });
  await name.pressSequentially("回归检查");
  check(
    (await name.inputValue()) === "回归检查",
    "dialog keeps input focus while typing",
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "创建播放集", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    (await page
      .getByLabel("编辑模组播放集")
      .locator("option:checked")
      .textContent()) === "回归检查",
    "new playset is selected",
  );
  check(
    (await page.locator("[role=switch][aria-checked=true]").count()) === 2,
    "copy playset preserves enabled mods",
  );
  await page.getByRole("button", { name: "全部停用", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector("[role=switch][aria-checked=true]"),
  );
  await page.getByLabel("编辑模组播放集").selectOption("default");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[role=switch][aria-checked=true]").length ===
      2,
  );
  check(true, "playsets maintain independent mod selections");
  await page.getByLabel("编辑模组播放集").selectOption({ label: "回归检查" });
  await page.getByRole("button", { name: "重命名当前播放集" }).click();
  await page.getByRole("textbox", { name: "播放集名称" }).fill("已重命名");
  await page.getByRole("button", { name: "保存名称" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    (await page
      .getByLabel("编辑模组播放集")
      .locator("option:checked")
      .textContent()) === "已重命名",
    "rename playset works",
  );
  await page.getByRole("button", { name: "删除当前播放集" }).click();
  await page.getByRole("button", { name: "删除播放集", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    (await page.getByLabel("编辑模组播放集").locator("option").count()) === 2,
    "delete playset selects a remaining preset",
  );
  if (await page.getByRole("button", { name: "关闭提示" }).count()) {
    await page.getByRole("button", { name: "关闭提示" }).click();
  }
  await page.screenshot({ path: resolve(output, "mods.png"), fullPage: true });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("默认启动模式").selectOption("debug");
  await page.reload();
  check(
    (await page.getByLabel("启动模式", { exact: true }).inputValue()) ===
      "debug",
    "launch preference persists",
  );
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  check(
    await page
      .getByRole("alert")
      .textContent()
      .then((text) => text.includes("当前为界面预览")),
    "browser preview cannot launch a game",
  );
  await page.getByRole("button", { name: "关闭提示" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.screenshot({
    path: resolve(output, "settings.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1000, height: 740 });
  await page.getByRole("button", { name: "总览", exact: true }).click();
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "minimum desktop size has no horizontal overflow",
  );
  await page.screenshot({
    path: resolve(output, "compact.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "narrow preview has no horizontal overflow",
  );

  const empty = await context.newPage();
  await empty.addInitScript(() => {
    const state = {
      settings: {
        gameDirectory: "",
        launchMode: "normal",
        playsets: [{ id: "default", name: "默认预设", modIds: ["missing"] }],
        activePlaysetId: "default",
      },
      game: { found: false, directory: "", executable: "", version: null },
      mods: [],
      paths: {
        userData: "isolated-fixture",
        settings: "isolated-fixture/settings.json",
      },
      warnings: [],
    };
    window.launcher = {
      getState: async () => {
        state.warnings = state.settings.playsets[0].modIds.includes("missing")
          ? ["当前播放集有 1 个模组不可用，请移除或重新安装后启动。"]
          : [];
        return structuredClone(state);
      },
      saveSettings: async (patch) => {
        Object.assign(state.settings, patch);
        return structuredClone(state.settings);
      },
      detectGame: async () => structuredClone(state),
    };
  });
  await empty.goto("http://127.0.0.1:4173");
  await empty.getByText("等待配置游戏目录").waitFor();
  check(
    await empty
      .getByRole("button", { name: "启动游戏", exact: true })
      .isDisabled(),
    "missing game blocks launch",
  );
  check(
    await empty
      .getByText("当前播放集有 1 个模组文件缺失，请清理后再启动。")
      .isVisible(),
    "missing selected mod is surfaced",
  );
  await empty.getByRole("button", { name: "移除缺失项" }).click();
  await empty
    .getByRole("button", { name: "移除缺失项" })
    .waitFor({ state: "hidden" });
  check(true, "missing mod can be removed without losing the playset");
  check(
    (await empty.locator(".warning-banner").count()) === 0,
    "repairing the playset also clears stale scan diagnostics",
  );
  await empty.screenshot({
    path: resolve(output, "first-run.png"),
    fullPage: true,
  });
  await empty.getByRole("button", { name: "模组管理" }).click();
  check(
    await empty.getByText("你的模组库，等待集结").isVisible(),
    "fresh install shows instructions instead of sample mods",
  );
  check(
    await empty.getByRole("button", { name: "删除当前播放集" }).isDisabled(),
    "last playset cannot be deleted",
  );
  await page.setViewportSize({ width: 1320, height: 940 });
  await page.getByRole("button", { name: "模组管理" }).click();
  await page
    .getByRole("region", { name: "当前播放集模组", exact: true })
    .waitFor();
  check(
    (await page.getByRole("switch").count()) === 3,
    "disabled mods remain members of the playset",
  );
  await page
    .getByRole("button", { name: "上移 Coloured Buttons", exact: true })
    .click();
  check(
    (await page
      .locator(".playset-members .mod-row")
      .nth(1)
      .locator("h3")
      .textContent()) === "Coloured Buttons",
    "load order arrows move the selected member",
  );
  await page
    .getByRole("switch", { name: "停用 State Transfer Tool", exact: true })
    .click();
  await page
    .getByRole("switch", { name: "启用 State Transfer Tool", exact: true })
    .click();
  check(
    (await page
      .locator(".playset-members .mod-row")
      .nth(2)
      .locator("h3")
      .textContent()) === "State Transfer Tool",
    "re-enabling a member preserves its position",
  );
  await page
    .getByRole("button", { name: "导入官方播放集", exact: true })
    .click();
  await page
    .getByRole("button", { name: "导入 1 个播放集", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    (await page
      .getByLabel("编辑模组播放集")
      .locator("option:checked")
      .textContent()) === "官方预设（示例）",
    "official import selects the imported active preset",
  );
  check(
    (await page.getByRole("switch").count()) === 2 &&
      (await page.locator("[role=switch][aria-checked=true]").count()) === 1,
    "official import preserves disabled membership",
  );
  await page.screenshot({
    path: resolve(output, "playset-order.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "DLC 管理", exact: true }).click();
  check(
    (await page
      .getByRole("switch", { name: "启用 DLC Sabaton Soundtrack", exact: true })
      .getAttribute("aria-checked")) === "false",
    "official preset DLC choice is shown",
  );
  await page
    .getByRole("switch", { name: "停用 DLC No Step Back", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "DLC 管理", exact: true }).click();
  check(
    (await page
      .getByRole("switch", { name: "启用 DLC No Step Back", exact: true })
      .getAttribute("aria-checked")) === "false",
    "DLC selection survives reload",
  );
  await page.screenshot({ path: resolve(output, "dlc.png"), fullPage: true });
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page.getByLabel("当前模组播放集").selectOption("default");
  await page.getByRole("button", { name: "DLC 管理", exact: true }).click();
  check(
    (await page
      .getByRole("switch", { name: "停用 DLC No Step Back", exact: true })
      .getAttribute("aria-checked")) === "true",
    "DLC choices are independent across playsets",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("渲染器", { exact: true }).selectOption("opengl");
  await page.getByLabel("游戏语言", { exact: true }).selectOption("l_english");
  await page.getByRole("switch", { name: "垂直同步", exact: true }).click();
  await page.getByLabel("显示模式", { exact: true }).selectOption("windowed");
  await page.getByLabel("刷新率", { exact: true }).selectOption("144");
  await page
    .getByRole("switch", { name: "启动游戏后关闭启动器", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  check(
    (await page.getByLabel("渲染器", { exact: true }).inputValue()) ===
      "opengl" &&
      (await page.getByLabel("游戏语言", { exact: true }).inputValue()) ===
        "l_english" &&
      (await page.getByLabel("刷新率", { exact: true }).inputValue()) === "144",
    "official game setting preferences persist",
  );
  check(
    (await page
      .getByRole("switch", { name: "垂直同步", exact: true })
      .getAttribute("aria-checked")) === "false" &&
      (await page
        .getByRole("switch", { name: "启动游戏后关闭启动器", exact: true })
        .getAttribute("aria-checked")) === "true",
    "game and launcher toggle preferences persist",
  );
  await page
    .getByRole("button", { name: "备份并清理缓存", exact: true })
    .click();
  check(
    (await page.getByLabel(/着色器缓存/).isChecked()) &&
      !(await page.getByLabel(/模组描述文件/).isChecked()),
    "cache cleanup selects safe cache and requires explicit user-content opt-in",
  );
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "模组管理" }).click();
  await page
    .getByRole("button", { name: "导出当前播放集", exact: true })
    .click();
  const exported = JSON.parse(
    await page.getByLabel("播放集 JSON", { exact: true }).inputValue(),
  );
  check(
    exported.game === "hoi4" &&
      exported.mods.length === 3 &&
      exported.mods[0].enabled === false,
    "export uses official JSON with disabled remote members",
  );
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await page.getByLabel("播放集 JSON", { exact: true }).fill(
    JSON.stringify({
      game: "hoi4",
      name: "导入检查",
      mods: [
        {
          displayName: "尚未安装的模组",
          steamId: "900123456",
          position: 0,
          enabled: true,
        },
      ],
    }),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导入 JSON", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("region", { name: "当前播放集模组", exact: true })
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "尚未安装的模组", exact: true })
      .isVisible(),
    "import keeps missing mod identity and display name",
  );
  await page.getByRole("button", { name: "总览", exact: true }).click();
  check(
    await page
      .getByRole("button", { name: "启动游戏", exact: true })
      .isDisabled(),
    "enabled missing imported mod blocks launch",
  );
  check(errors.length === 0, `no browser runtime errors: ${errors.join("; ")}`);
  await page.getByRole("button", { name: "模组管理" }).click();
  await page.getByRole("button", { name: "创建本地模组", exact: true }).click();
  await page.getByLabel("模组名称", { exact: true }).fill("My first mod");
  await page.getByLabel("模组文件夹名称", { exact: true }).fill("my_first_mod");
  await page.screenshot({
    path: resolve(output, "local-mod-editor.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "创建模组", exact: true }).click();
  await page
    .getByText("当前为界面预览，请在桌面版中创建本地模组。", { exact: true })
    .waitFor();
  check(
    await page.getByRole("dialog", { name: "创建本地模组" }).isVisible(),
    "preview authoring explains desktop requirement and preserves the form",
  );
  check(
    errors.length === 0,
    `no authoring runtime errors: ${errors.join("; ")}`,
  );
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "发现模组", exact: true }).click();
  await page
    .getByText("当前为界面预览；桌面版可浏览真实 Paradox 模组。", {
      exact: true,
    })
    .waitFor();
  check(
    await page.getByLabel("搜索在线模组", { exact: true }).isVisible(),
    "catalog handles unavailable online data without false search results",
  );
  check(
    await page.getByLabel("Paradox 下载限速").isVisible(),
    "PDX local downloads expose a separate speed limit",
  );
  check(
    (await page.getByLabel("Paradox 下载身份").inputValue()) === "anonymous",
    "PDX downloads default to anonymous access",
  );
  await page.getByLabel("Paradox 下载身份").selectOption("account");
  check(
    await page.getByText(/退出或重新登录会停止尚未完成的下载/).isVisible(),
    "account download choice explains login and session changes",
  );
  await page.getByLabel("Paradox 下载限速").selectOption(String(1024 ** 2));
  await page.getByText("请在桌面版中设置下载限速。", { exact: true }).waitFor();
  check(
    (await page.getByLabel("Paradox 下载限速").inputValue()) === "0",
    "preview cannot persist or execute actual download controls",
  );
  await page
    .locator(".member-tabs")
    .getByRole("button", { name: "Steam 创意工坊", exact: true })
    .click();
  await page.getByRole("button", { name: "连接 Steam", exact: true }).click();
  await page
    .getByText("当前为界面预览，请在桌面版中连接 Steam。", { exact: true })
    .waitFor();
  check(
    await page
      .getByRole("button", { name: "连接 Steam", exact: true })
      .isVisible(),
    "Steam UI requires explicit connection and preview cannot initialize SDK",
  );
  await page.screenshot({
    path: resolve(output, "steam-workshop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", { name: "登录 Paradox 账户", exact: true })
    .click();
  await page
    .getByLabel("Paradox 电子邮箱", { exact: true })
    .fill("fixture@example.test");
  await page
    .getByLabel("Paradox 密码", { exact: true })
    .fill("fixture-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByText("请在桌面版中登录 Paradox 账户。", { exact: true })
    .waitFor();
  check(
    (await page.getByLabel("Paradox 密码", { exact: true }).inputValue()) ===
      "",
    "failed login clears the password field",
  );
  check(
    await page.getByRole("checkbox", { name: /在此设备保持登录/ }).isDisabled(),
    "remember-login option requires operating system encryption",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    errors.length === 0,
    `no online or account runtime errors: ${errors.join("; ")}`,
  );
  console.log(`UI checks completed: ${checks}. Screenshots: ${output}`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
}
