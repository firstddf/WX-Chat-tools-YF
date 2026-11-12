// docs/07 #18：关于 / 帮助（内置离线弹窗）——账号栏入口、字段内容、关闭方式。
// 关于字段全部来自现有 AppInfo 与构建期 `__BUILD_INFO__`（协议未改）；帮助内容随包分发。
import { expect, test } from '@playwright/test';

test('关于 #18 弹窗：版本 / 协议版本 / 构建信息 / 作者 / 仓库 / 隐私 / 非商用许可 + Esc 关闭', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('btn_about').click();

  const modal = page.getByTestId('about_modal');
  await expect(modal).toBeVisible();
  await expect(page.getByTestId('about_name')).toHaveText('微信聊天记录工具');
  await expect(page.getByTestId('about_version')).toHaveText('0.1.0');
  await expect(page.getByTestId('about_protocol')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('about_sidecar')).toHaveText(/ready|starting|failed|mismatch|restarted/);
  // 构建信息 = 构建时间 · git 提交号（vite define 注入）
  await expect(page.getByTestId('about_build')).toContainText('·');
  // 作者 + 仓库地址（纯文本展示，不加 <a href>——零外链口径见 security.spec C）
  await expect(page.getByTestId('about_author')).toHaveText('firstddf');
  await expect(page.getByTestId('about_repo')).toHaveText(
    'https://github.com/firstddf/WX-Chat-tools-YF',
  );
  await expect(page.getByTestId('about_privacy')).toContainText('只读');
  await expect(page.getByTestId('about_privacy')).toContainText('不联网');
  await expect(page.getByTestId('about_license')).toContainText('PolyForm Noncommercial');
  await expect(page.getByTestId('about_license')).toContainText('Required Notice');

  // Esc 关闭（监听挂/摘成对由 A1 #10 卸载用例兜底）
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('帮助 #18 弹窗：内置离线帮助含快速上手/常见问题/隐私 + 点遮罩关闭', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('btn_help').click();

  const modal = page.getByTestId('help_modal');
  await expect(modal).toBeVisible();
  const body = page.getByTestId('help_body');
  await expect(page.getByTestId('help_sec_quick')).toBeVisible();
  await expect(body).toContainText('加载/刷新数据');
  await expect(body).toContainText('导出');
  await expect(page.getByTestId('help_sec_faq')).toBeVisible();
  await expect(body).toContainText('KEY_NOT_FOUND');
  await expect(body).toContainText('选择数据目录');
  await expect(body).toContainText('SILK'); // 语音听不了的根因说明
  await expect(body).toContainText('气泡上按下'); // 框选口径
  await expect(body).toContainText('隐私与安全');
  await expect(body).toContainText('PolyForm Noncommercial');

  // 关闭按钮 → 关闭
  await page.getByTestId('help_close').click();
  await expect(modal).toHaveCount(0);

  // 再开 → 点遮罩（卡片外）关闭
  await page.getByTestId('btn_help').click();
  await expect(page.getByTestId('help_modal')).toBeVisible();
  await page.getByTestId('help_modal').click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('help_modal')).toHaveCount(0);
});
