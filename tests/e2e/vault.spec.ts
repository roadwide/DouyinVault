import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "e2e-password-123";

async function login(page: Page): Promise<void> {
  await page.goto("/");
  const password = page.locator('input[type="password"]').first();
  await expect(password).toBeVisible();
  await password.fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: /视频收件箱/ })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw new Error(`Uncaught page error: ${error.message}`);
  });
});

test("dashboard shows listener, storage, and recent cached videos", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await login(page);
  await expect(page.getByText("缓存成功视频")).toBeVisible();
  await expect(page.getByText("正常监听群聊")).toBeVisible();
  await expect(page.getByText("监听运行中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近缓存" })).toBeVisible();
  await expect(page.getByRole("link", { name: /海边日落的 30 秒/ })).toBeVisible();
  const recent = page.locator('a[href^="/videos/"]');
  await expect(recent.first()).toBeVisible();
  expect(await recent.count()).toBeGreaterThanOrEqual(6);
});

test("library filters, search, selection, and detail playback UI", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await login(page);
  await page.getByRole("link", { name: "视频库" }).first().click();
  await expect(page.getByRole("heading", { name: "视频库" })).toBeVisible();
  await expect(page.getByText("全部 · 7 个视频")).toBeVisible();
  await expect(page.getByTitle("平台返回该作品已删除、私密或不可访问")).toBeVisible();

  await page.getByRole("button", { name: "未观看" }).click();
  await expect(page.getByText("未观看 · 5 个视频")).toBeVisible();

  await page.getByRole("button", { name: "全部" }).click();
  const search = page.getByPlaceholder("搜索标题、作品 ID、分享人…");
  await search.fill("海边");
  await expect(page.getByText("全部 · 1 个视频")).toBeVisible();
  await search.fill("");

  await page.locator('a[href^="/videos/"]').first().click();
  await expect(page.getByRole("heading", { name: "海边日落的 30 秒" })).toBeVisible();
  await expect(page.getByRole("button", { name: "已收藏" })).toBeVisible();
  await expect(page.getByText("全部群聊来源")).toBeVisible();
  await expect(page.getByText("同一作品只保存一份文件")).toBeVisible();

  const markWatched = page.getByRole("button", { name: "标记已看" });
  if (await markWatched.count()) {
    await markWatched.click();
    await expect(page.getByRole("button", { name: "标记未看" })).toBeVisible();
  }
});

test("groups are opt-in and downloads page exposes failures and completions", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await login(page);
  await page.getByRole("link", { name: "群聊" }).first().click();
  await expect(page.getByRole("heading", { name: "群聊监听" })).toBeVisible();
  await expect(page.getByText("不会替你把群消息标为已读")).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(3);
  expect(await page.locator('[role="switch"][aria-checked="true"]').count()).toBe(2);

  await page.getByRole("link", { name: "下载" }).first().click();
  await expect(page.getByRole("heading", { name: "下载任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: /全部/ })).toBeVisible();
  await expect(page.getByText("已完成").first()).toBeVisible();
  await page.getByRole("button", { name: /失败/ }).click();
  await expect(page.getByText("作品已失效或作者设为私密").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" }).first()).toBeVisible();
});

test("settings expose retention, capacity, and cleanup controls", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop project only");
  await login(page);
  await page.getByRole("link", { name: "设置" }).first().click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("保留与观看")).toBeVisible();
  await expect(page.getByText("容量与磁盘")).toBeVisible();
  await expect(page.getByText("立即清理")).toBeVisible();
  await expect(page.getByText("备份数据库")).toBeVisible();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存")).toBeVisible();
});

test("mobile layout exposes bottom navigation and a usable library", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile project only");
  await login(page);
  const nav = page.locator("nav").filter({ hasText: "仪表盘" }).last();
  await expect(nav).toBeVisible();
  await page.getByRole("link", { name: "视频库" }).last().click();
  await expect(page.getByRole("heading", { name: "视频库" })).toBeVisible();
  await expect(page.locator('a[href^="/videos/"]').first()).toBeVisible();
  await expect(page.getByPlaceholder("搜索标题、作品 ID、分享人…")).toBeVisible();
  await page.screenshot({ path: "test-results/mobile-library.png", fullPage: true });
});
