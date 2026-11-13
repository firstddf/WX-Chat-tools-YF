// #19 快递单号提取页（docs/07 #19，2026-11-13）：
// 1) 页签与默认态——第 4 页签追加末尾、默认激活页仍「数据筛选」、
//    联网审核默认关闭、纯本地提示可见、披露框隐藏；
// 2) 联网披露（拍板③）——开启后明示将发送行数与去向（纯文本，不产生外链），
//    预检 → 行数入披露框；API Key 输入仅联网时出现；
// 3) 零外链守卫——本页开启联网后 DOM 仍无 http(s) 资源（security.spec C 的页级补充，
//    断言本身不放宽：默认态全应用断言在 security.spec，此处只加不减）。
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 1000 } });

async function gotoTracking(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab_tracking').click();
  await expect(page.getByTestId('page_tracking')).toBeVisible();
}

test('快递单号提取 #19：页签顺序 + 默认纯本地（联网关、披露隐藏、本地提示可见）', async ({
  page,
}) => {
  await page.goto('/');

  // 页签顺序：前三个照 Tk（导出 → 数据筛选 → 聊天数据管理），#19 新页追加末尾
  const tabs = page.locator('.tabbar button');
  await expect(tabs.nth(0)).toHaveText('导出');
  await expect(tabs.nth(1)).toHaveText('数据筛选');
  await expect(tabs.nth(2)).toHaveText('聊天数据管理');
  await expect(tabs.nth(3)).toHaveText('快递单号提取');

  // 默认激活页仍为「数据筛选」（#17 A5 口径不受新页影响）
  await expect(page.getByTestId('page_filter')).toBeVisible();

  await page.getByTestId('tab_tracking').click();
  const trk = page.getByTestId('page_tracking');
  await expect(trk).toBeVisible();

  // 拍板①：默认纯本地——联网关、披露隐藏、本地准确率提示可见
  await expect(page.getByTestId('trk_var_network')).not.toBeChecked();
  await expect(page.getByTestId('trk_disclosure')).toHaveCount(0);
  await expect(page.getByTestId('trk_local_hint')).toBeVisible();
  await expect(page.getByTestId('trk_local_hint')).toContainText('准确率有限');
  // 联网 Key 输入仅在开启后出现
  await expect(page.getByTestId('trk_entry_key')).toHaveCount(0);

  // 动作与日志骨架
  await expect(page.getByTestId('btn_trk_preflight')).toBeVisible();
  await expect(page.getByTestId('btn_trk_start')).toBeVisible();
  await expect(page.getByTestId('trk_log')).toBeVisible();
});

test('快递单号提取 #19：联网披露——开启后明示行数与去向，预检入框（纯文本零外链）', async ({
  page,
}) => {
  await gotoTracking(page);

  // 先选输入文件（预检前置校验）
  await page.getByTestId('btn_trk_in').click();
  await expect(page.getByTestId('trk_entry_in')).toHaveValue('C:/mock/微信导出.csv');

  // 开启联网 → 披露框出现（未预检时行数为 0，文案含去向）；Key 输入出现
  await page.getByTestId('trk_var_network').check();
  const disclosure = page.getByTestId('trk_disclosure');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('api.xiaomimimo.com');
  await expect(disclosure).toContainText('将把');
  await expect(page.getByTestId('trk_entry_key')).toBeVisible();
  await expect(page.getByTestId('trk_local_hint')).toHaveCount(0);

  // 预检（mock preflight：候选 42 + 回检抽样 300 = 342）→ 披露行数入框 + Key 未存提示
  await page.getByTestId('btn_trk_preflight').click();
  await expect(page.getByTestId('trk_notice')).toContainText('将发送 342 行');
  await expect(disclosure).toContainText('将把 342 行消息文本发送到第三方 API');
  await expect(page.getByTestId('trk_key_state')).toContainText('未保存 Key');
  await expect(page.getByTestId('trk_log')).toContainText('api.xiaomimimo.com');

  // 关回本地 → 披露框消失、Key 输入收回、本地提示回来（可随时不用）
  await page.getByTestId('trk_var_network').uncheck();
  await expect(disclosure).toHaveCount(0);
  await expect(page.getByTestId('trk_entry_key')).toHaveCount(0);
  await expect(page.getByTestId('trk_local_hint')).toBeVisible();

  // 零外链守卫：本页（含开启联网态）DOM 无任何 http(s) 资源属性
  await page.getByTestId('trk_var_network').check();
  const external = await page.evaluate(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length;
    return {
      anchors: count('a[href^="http"]'),
      images: count('img[src^="http"]'),
      links: count('link[href^="http"]'),
      scripts: count('script[src^="http"]'),
    };
  });
  expect(external).toEqual({ anchors: 0, images: 0, links: 0, scripts: 0 });
});

test('快递单号提取 #19：预检与提取流程——参数入 calls、完成提示入日志', async ({ page }) => {
  await gotoTracking(page);

  // 选输入文件（浏览器态 pickOpenPath 回建议绝对路径）→ 输出自动推导
  await page.getByTestId('btn_trk_in').click();
  await expect(page.getByTestId('trk_entry_in')).toHaveValue('C:/mock/微信导出.csv');
  await expect(page.getByTestId('trk_entry_out')).toHaveValue(
    'C:/mock/微信导出_提取快递单号.csv',
  );

  // 预检（纯本地）→ 计数入 notice
  await page.getByTestId('btn_trk_preflight').click();
  await expect(page.getByTestId('trk_notice')).toContainText('纯本地（不发送任何数据）');

  // 开始提取（mock run）→ 完成提示 + 日志
  await page.getByTestId('btn_trk_start').click();
  await expect(page.getByTestId('trk_notice')).toContainText('提取完成');
  await expect(page.getByTestId('trk_notice')).toContainText('有单号行');
  await expect(page.getByTestId('trk_log')).toContainText('开始提取（纯本地）');
});

test('快递单号提取 BUG2：服务商多选 + 自定义 base_url/model + 披露去向随服务商', async ({
  page,
}) => {
  await gotoTracking(page);
  await page.getByTestId('btn_trk_in').click();

  await page.getByTestId('trk_var_network').check();
  const provider = page.getByTestId('trk_provider');
  await expect(provider).toBeVisible();
  await expect(provider).toHaveValue('mimo'); // 缺省 = 旧单 Key 口径

  // 预设展示 base_url + 模型；去向进披露框（纯文本，零外链不放宽）
  await expect(page.getByTestId('trk_provider_info')).toContainText('api.xiaomimimo.com');
  await expect(page.getByTestId('trk_disclosure')).toContainText('api.xiaomimimo.com');

  // 切 DeepSeek → 展示与披露去向同步
  await provider.selectOption('deepseek');
  await expect(page.getByTestId('trk_provider_info')).toContainText('api.deepseek.com');
  await expect(page.getByTestId('trk_disclosure')).toContainText('api.deepseek.com');
  await expect(page.getByTestId('trk_entry_base')).toHaveCount(0);

  // 切自定义 → base_url/model 输入出现
  await provider.selectOption('custom');
  await expect(page.getByTestId('trk_entry_base')).toBeVisible();
  await expect(page.getByTestId('trk_entry_model')).toBeVisible();
  await expect(page.getByTestId('trk_provider_info')).toHaveCount(0);
});

test('快递单号提取 BUG2：保存 Key / 清除已存 Key（mode=key，不跑预检也能存）', async ({
  page,
}) => {
  await gotoTracking(page);
  await page.getByTestId('btn_trk_in').click();
  await page.getByTestId('trk_var_network').check();

  await expect(page.getByTestId('trk_key_state')).toContainText('未保存 Key');
  await expect(page.getByTestId('btn_trk_clear_key')).toHaveCount(0);

  // 空输入点保存 → 提示填写
  await page.getByTestId('btn_trk_save_key').click();
  await expect(page.getByTestId('trk_notice')).toContainText('请先填写 API Key');

  // 填 Key 保存 → 状态翻转 + 输入清空 + 清除按钮出现（key 入 calls 供断言）
  await page.getByTestId('trk_entry_key').fill('TEST-KEY-1');
  await page.getByTestId('btn_trk_save_key').click();
  await expect(page.getByTestId('trk_key_state')).toContainText('本机已存 Key');
  await expect(page.getByTestId('trk_notice')).toContainText('已加密保存');
  await expect(page.getByTestId('trk_entry_key')).toHaveValue('');
  await expect(page.getByTestId('btn_trk_clear_key')).toBeVisible();

  // 清除 → 回到未存
  await page.getByTestId('btn_trk_clear_key').click();
  await expect(page.getByTestId('trk_key_state')).toContainText('未保存 Key');
  await expect(page.getByTestId('btn_trk_clear_key')).toHaveCount(0);
});
