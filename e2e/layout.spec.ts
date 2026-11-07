// 布局验收（docs/04 A1）—— #4 气泡贴边/勾选框位/头像间距；#11 气泡不溢出、长串换行。
// 这两项需要真实布局（getBoundingClientRect），jsdom 给不了，故用 Playwright。
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText('共 11796 条消息', {
    timeout: 20_000,
  });
});

test('A1 #4 气泡贴边：mine 右贴 / other 左贴 / 勾选框位 / 头像间距 > 0', async ({ page }) => {
  await page.getByTestId('btn_select_all').click(); // 进入多选（M-A2 无右键入口，用全选按钮）
  await expect(page.locator('.msg-row.mine .checkbox').first()).toBeVisible();

  const filterPage = page.getByTestId('page_filter');
  const list = filterPage.getByTestId('message_view');
  const listBox = (await list.boundingBox())!;
  expect(listBox.width).toBeGreaterThan(100);

  const mine = filterPage.locator('.msg-row.mine').first();
  const other = filterPage.locator('.msg-row:not(.mine)').first();
  const mineBubble = (await mine.locator('.bubble').boundingBox())!;
  const otherBubble = (await other.locator('.bubble').boundingBox())!;

  // mine 气泡在右半边且贴近右缘（行内 36px 留白 + 勾选框 + 头像）
  expect(mineBubble.x + mineBubble.width).toBeGreaterThan(listBox.x + listBox.width * 0.7);
  expect(mineBubble.x).toBeGreaterThan(listBox.x + listBox.width * 0.4);
  // other 气泡在左半边
  expect(otherBubble.x).toBeLessThan(listBox.x + listBox.width * 0.5);

  // 勾选框位：本人右侧、他人左侧
  const mineCb = (await mine.locator('.checkbox').boundingBox())!;
  const otherCb = (await other.locator('.checkbox').boundingBox())!;
  expect(mineCb.x).toBeGreaterThan(listBox.x + listBox.width * 0.8);
  expect(otherCb.x - listBox.x).toBeLessThan(30);
  expect(mineCb.x + mineCb.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);

  // 头像与勾选框不重叠、留出间隔（间距 > 0）
  const mineAvatar = (await mine.locator('.avatar').boundingBox())!;
  expect(mineCb.x - (mineAvatar.x + mineAvatar.width)).toBeGreaterThan(0);
  const otherAvatar = (await other.locator('.avatar').boundingBox())!;
  expect(otherAvatar.x - (otherCb.x + otherCb.width)).toBeGreaterThan(0);
  // 头像紧贴气泡（间距小而为正）
  expect(mineAvatar.x - (mineBubble.x + mineBubble.width)).toBeGreaterThan(0);
  expect(mineAvatar.x - (mineBubble.x + mineBubble.width)).toBeLessThan(20);
});

test('A1 #11 气泡不溢出、长串在 400px 内换行', async ({ page }) => {
  // 合成数据里埋了 300 字符无空格长串（每 997 条一条），先筛出来让它进窗口
  await page.getByTestId('entry_query').fill('长串测试');
  await page.getByTestId('entry_query').press('Enter');
  await expect(page.getByTestId('lbl_status')).toContainText('匹配 11 条');

  const filterPage = page.getByTestId('page_filter');
  const listBox = (await filterPage.getByTestId('message_view').boundingBox())!;
  const bubble = filterPage.locator('.bubble', { hasText: '长串测试' }).first();
  await expect(bubble).toBeVisible();
  const bBox = (await bubble.boundingBox())!;

  // 气泡完整落在列表可视区内（不横向溢出）
  expect(bBox.x).toBeGreaterThanOrEqual(listBox.x - 1);
  expect(bBox.x + bBox.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
  // 300 字符长串必须换行：高度明显大于单行（单行 ≈ 14px*1.6 + 16 内边距 ≈ 39）
  expect(bBox.height).toBeGreaterThan(60);
  // 换行宽度受控：气泡远小于列表全宽（max-width 78% / 680px）
  expect(bBox.width).toBeLessThanOrEqual(Math.min(680, listBox.width * 0.78) + 2);
});
