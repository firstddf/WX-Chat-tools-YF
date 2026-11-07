// 组件行为测试（M-A2）：@vue/test-utils + jsdom，逐条覆盖
// wxchart-tool/tests/test_datepicker.py 中除纯函数外的 14 项 Tk 测试（命名一一对应），
// 加上 date.spec.ts 的 2 项纯函数向量 = 16 项 Tk 契约全覆盖。
//
// 说明：
// - Tk 的 Entry 代理（get/set/clear/insert/delete）在 Vue 侧映射为 v-model 往返；
// - Tk 的 App 集成（FilterPanel 真实重筛）由 lead 的 App/FilterPanel 测试负责，
//   这里验证其赖以工作的组件契约：多实例各自独立、点选/清除触发 apply。
import { defineComponent, h, ref } from 'vue';
import { it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DatePicker from '../src/components/DatePicker.vue';
import { todayString } from '../src/utils/date';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** 读取 input/select 的 value（wrapper.element 声明为 Element，需收窄）。 */
function valueOf(el: Element): string {
  return (el as HTMLInputElement | HTMLSelectElement).value;
}

/** 月历里当前可点击的日期数字（排除占位/禁用格，等价 Tk clickable_days）。 */
function clickableDays(wrapper: any): number[] {
  return wrapper
    .findAll('.dp-day')
    .filter((b: any) => !(b.element as HTMLButtonElement).disabled && /^\d+$/.test(b.text()))
    .map((b: any) => Number(b.text()))
    .sort((a: number, b: number) => a - b);
}

/** 找到某个可点击的日格（等价 Tk pick_day_button）。 */
function findDayButton(wrapper: any, day: number) {
  const btn = wrapper
    .findAll('.dp-day')
    .find((b: any) => b.text() === String(day) && !(b.element as HTMLButtonElement).disabled);
  if (!btn) throw new Error(`月历里找不到可点击的 ${day} 号`);
  return btn;
}

/** 颜色断言：jsdom 可能把 #rrggbb 规范成 rgb(r, g, b)，两种形式都接受。 */
function expectCssColor(actual: string, hex: string): void {
  const m = /^#(..)(..)(..)$/.exec(hex);
  if (!m) throw new Error(`bad hex color: ${hex}`);
  const rgb = `rgb(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)})`;
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  expect([norm(hex), norm(rgb)]).toContain(norm(actual));
}

/**
 * 设置月份下拉值并触发跳转。
 * Tk 的 readonly Combobox 可被 var_month.set('13') 程序化赋任意值，
 * 这里用「临时注入同值 option」等价模拟（渲染回写后下拉恢复 01..12）。
 */
async function setMonthSelect(wrapper: any, value: string): Promise<void> {
  const select = wrapper.find('select.dp-month');
  const el = select.element as HTMLSelectElement;
  if (!el.querySelector(`option[value="${value}"]`)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = value;
  await select.trigger('change');
}

// ---------------------------------------------------------------------------
// DatePickerField
// ---------------------------------------------------------------------------

it('test_datepicker_field_proxy', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-09-01' } });
  const input = wrapper.find('.dp-input');

  // get() / var 绑定
  expect(valueOf(input.element)).toBe('2026-09-01');
  // btn_calendar 存在且带 📅
  const btn = wrapper.find('.dp-btn-calendar');
  expect(btn.exists()).toBe(true);
  expect(btn.text()).toContain('📅');

  // set()：外部改值 → 输入框回填
  await wrapper.setProps({ modelValue: '2026-08-31' });
  expect(valueOf(input.element)).toBe('2026-08-31');

  // clear()：清空
  await wrapper.setProps({ modelValue: '' });
  expect(valueOf(input.element)).toBe('');

  // insert(0, '2026-08-31')：键入回填并 emit update:modelValue
  await input.setValue('2026-08-31');
  expect(valueOf(input.element)).toBe('2026-08-31');
  expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['2026-08-31']);

  // delete(0, 'end')
  await input.setValue('');
  expect(valueOf(input.element)).toBe('');

  // set(None) → get() == ''
  await wrapper.setProps({ modelValue: null as unknown as string });
  expect(valueOf(input.element)).toBe('');
});

it('test_datepicker_field_return_callback', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-09-01' } });
  const input = wrapper.find('.dp-input');

  await input.trigger('keydown', { key: 'Enter' });

  // 回车触发提交回调（Tk on_return / 默认 Return → _notify）
  const applies = wrapper.emitted('apply');
  expect(applies).toHaveLength(1);
  expect(applies![0]).toEqual(['2026-09-01']);
  // 回车不自动改值、不产生新的回填
  expect(valueOf(input.element)).toBe('2026-09-01');
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
});

it('test_datepicker_field_normalize_on_focusout', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '' } });
  const input = wrapper.find('.dp-input');

  await input.setValue('2026/9/1');
  await input.trigger('blur');
  expect(valueOf(input.element)).toBe('2026-09-01');
  expect(wrapper.emitted('apply')).toHaveLength(1);
  expect(wrapper.emitted('apply')![0]).toEqual(['2026-09-01']);

  await input.setValue('20260901');
  await input.trigger('blur');
  expect(valueOf(input.element)).toBe('2026-09-01');
  expect(wrapper.emitted('apply')).toHaveLength(2);
  expect(wrapper.emitted('update:modelValue')).toContainEqual(['2026-09-01']);

  // 非法输入保持原样，且不触发 apply（没规整出值 = 没有可提交的值）
  await input.setValue('不是日期');
  await input.trigger('blur');
  expect(valueOf(input.element)).toBe('不是日期');
  expect(wrapper.emitted('apply')).toHaveLength(2);
});

it('test_datepicker_field_open_calendar', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026/9/15' } });

  // 按输入日期打开对应月份，选中日 = 输入日期
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(true);
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-09');
  const selected = wrapper
    .findAll('.dp-day')
    .filter((b: any) => b.classes().includes('is-selected'));
  expect(selected.map((b: any) => b.text())).toEqual(['15']);

  await wrapper.find('.dp-foot-close').trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(false);

  // 空值 → 今天所在月
  await wrapper.setProps({ modelValue: '' });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  const [ty, tm] = todayString().split('-');
  expect(wrapper.find('.dp-view-label').text()).toBe(`${ty}-${tm}`);
});

// ---------------------------------------------------------------------------
// CalendarPopup
// ---------------------------------------------------------------------------

it('test_calendar_popup_initial_and_month_lengths', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-02-01' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');

  // 初始年月/标签/年份输入/月份下拉 + 恒 42 格
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-02');
  expect(valueOf(wrapper.find('.dp-year').element)).toBe('2026');
  expect((wrapper.find('.dp-month').element as HTMLSelectElement).value).toBe('02');
  expect(wrapper.findAll('.dp-day')).toHaveLength(42);
  expect(clickableDays(wrapper)).toEqual(range(1, 28)); // 2026-02 → 28 天

  // 2026-09 有 30 天
  await wrapper.setProps({ modelValue: '2026-09-01' });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(clickableDays(wrapper)).toEqual(range(1, 30));
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-09');

  // 闰年 2028-02 有 29 天（Tk 边界回归）
  await wrapper.setProps({ modelValue: '2028-02-01' });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(clickableDays(wrapper)).toEqual(range(1, 29));

  // 规格补充：2024-02 同为闰年 29 天
  await wrapper.setProps({ modelValue: '2024-02-01' });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(clickableDays(wrapper)).toEqual(range(1, 29));
});

it('test_calendar_popup_navigation_cross_year', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-12-15' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');

  // 12 月下一月 → 跨年 2027-01
  await wrapper.find('.dp-next').trigger('click');
  expect(wrapper.find('.dp-view-label').text()).toBe('2027-01');
  expect(valueOf(wrapper.find('.dp-year').element)).toBe('2027');
  expect((wrapper.find('.dp-month').element as HTMLSelectElement).value).toBe('01');

  // 1 月上一月 → 回到 2026-12
  await wrapper.find('.dp-prev').trigger('click');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-12');
  expect(valueOf(wrapper.find('.dp-year').element)).toBe('2026');
  expect((wrapper.find('.dp-month').element as HTMLSelectElement).value).toBe('12');

  // 跳到 2026-01 再上一月 → 2025-12
  await setMonthSelect(wrapper, '01');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-01');
  await wrapper.find('.dp-prev').trigger('click');
  expect(wrapper.find('.dp-view-label').text()).toBe('2025-12');
});

it('test_calendar_popup_jump', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-02-01' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  const yearInput = wrapper.find('.dp-year');

  // 年份 + 月份直跳 → 2026-09
  await yearInput.setValue('2026');
  await yearInput.trigger('change');
  await setMonthSelect(wrapper, '09');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-09');

  // 非法年份：不跳转，年份输入保留原值（不回写）
  await yearInput.setValue('abc');
  await yearInput.trigger('change');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-09');
  expect(valueOf(yearInput.element)).toBe('abc');

  // 恢复合法年份 2027；月份 13 → 夹到 12 月
  await yearInput.setValue('2027');
  await yearInput.trigger('change');
  expect(wrapper.find('.dp-view-label').text()).toBe('2027-09');
  await setMonthSelect(wrapper, '13');
  expect(wrapper.find('.dp-view-label').text()).toBe('2027-12');
  expect((wrapper.find('.dp-month').element as HTMLSelectElement).value).toBe('12');

  // 月份 0 → 夹到 1 月
  await setMonthSelect(wrapper, '0');
  expect(wrapper.find('.dp-view-label').text()).toBe('2027-01');
  expect((wrapper.find('.dp-month').element as HTMLSelectElement).value).toBe('01');
});

it('test_calendar_popup_pick_today_and_clear', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-02-01' } });

  // 今天 → 回填今天并关闭
  await wrapper.find('.dp-btn-calendar').trigger('click');
  await wrapper.find('.dp-today').trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(false);
  expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([todayString()]);
  expect(wrapper.emitted('apply')!.at(-1)).toEqual([todayString()]);

  // 清除 → 回填空串（= 不限）并关闭
  await wrapper.find('.dp-btn-calendar').trigger('click');
  await wrapper.find('.dp-clear').trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(false);
  expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['']);
  expect(wrapper.emitted('apply')!.at(-1)).toEqual(['']);
});

it('test_calendar_popup_pick_day_destroys_and_callback', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-09-10' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');

  await findDayButton(wrapper, 15).trigger('click');

  expect(wrapper.find('.dp-popup').exists()).toBe(false);
  expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['2026-09-15']);
  expect(wrapper.emitted('apply')!.at(-1)).toEqual(['2026-09-15']);
  expect(valueOf(wrapper.find('.dp-input').element)).toBe('2026-09-15');
});

it('test_calendar_popup_selected_day_highlighted', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-09-15' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');

  // 选中日：高亮底色 #1f6feb + 白字
  const sel = findDayButton(wrapper, 15);
  expect(sel.classes()).toContain('is-selected');
  expectCssColor((sel.element as HTMLElement).style.backgroundColor, '#1f6feb');
  expectCssColor((sel.element as HTMLElement).style.color, '#ffffff');

  // 2026-09-05 是周六且非选中日 → 红字 #c0392b
  const sat = findDayButton(wrapper, 5);
  expect(sat.classes()).not.toContain('is-selected');
  expectCssColor((sat.element as HTMLElement).style.color, '#c0392b');
});

it('test_calendar_popup_no_stale_days_after_shorter_month', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2026-08-01' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(clickableDays(wrapper)).toEqual(range(1, 31)); // 2026-08 → 1..31（6 周）

  await wrapper.find('.dp-next').trigger('click');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-09');
  expect(clickableDays(wrapper)).toEqual(range(1, 30)); // 1..30，无残留 31

  const all = wrapper.findAll('.dp-day');
  // 9 月只用 5 周 = 35 格，其余按钮应清空并禁用
  for (const btn of all.slice(35)) {
    expect(btn.text()).toBe('');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  }
  // 不应存在任何可点的「31」
  expect(
    all.filter((b: any) => b.text() === '31' && !(b.element as HTMLButtonElement).disabled),
  ).toHaveLength(0);

  // 规格补充：6 周的 5 月 → 2 月后只剩 28 个可点日，无 29/30/31 残留
  await wrapper.setProps({ modelValue: '2026-05-01' });
  await wrapper.find('.dp-btn-calendar').trigger('click');
  expect(clickableDays(wrapper)).toEqual(range(1, 31));
  await setMonthSelect(wrapper, '02');
  expect(wrapper.find('.dp-view-label').text()).toBe('2026-02');
  expect(clickableDays(wrapper)).toEqual(range(1, 28));
  const feb = wrapper.findAll('.dp-day');
  for (const stale of ['29', '30', '31']) {
    expect(
      feb.filter((b: any) => b.text() === stale && !(b.element as HTMLButtonElement).disabled),
    ).toHaveLength(0);
  }
});

it('test_calendar_popup_initial_extra_buttons_disabled', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '2021-02-01' } });
  await wrapper.find('.dp-btn-calendar').trigger('click');

  expect(clickableDays(wrapper)).toEqual(range(1, 28)); // 4 周月份
  const all = wrapper.findAll('.dp-day');
  for (const btn of all.slice(28)) {
    expect(btn.text()).toBe('');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  }
});

it('test_datepicker_field_single_popup', async () => {
  const wrapper = mount(DatePicker, { props: { modelValue: '' } });
  const btn = wrapper.find('.dp-btn-calendar');

  await btn.trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(true);
  const first = wrapper.find('.dp-popup').element;

  // 连点 📅：旧弹层销毁、新弹层打开，不叠加
  await btn.trigger('click');
  expect(wrapper.find('.dp-popup').exists()).toBe(true);
  const second = wrapper.find('.dp-popup').element;
  expect(second).not.toBe(first);
  expect(first.isConnected).toBe(false);
  expect(wrapper.findAll('.dp-popup')).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// App / FilterTab 集成（组件契约侧）
// ---------------------------------------------------------------------------

/** 模拟 App：4 个 DatePickerField（导出 2 + 筛选 2），apply = FilterPanel 重筛信号。 */
const Host = defineComponent({
  setup() {
    const d0 = ref('2026-09-01');
    const d1 = ref('');
    const d2 = ref('');
    const d3 = ref('');
    const log: string[] = [];
    function onApply(which: string, value: string): void {
      log.push(`${which}:${value}`);
    }
    return { d0, d1, d2, d3, log, onApply };
  },
  render() {
    return h('div', [
      h(DatePicker, {
        modelValue: this.d0,
        'onUpdate:modelValue': (v: string) => {
          this.d0 = v;
        },
        onApply: (v: string) => this.onApply('d0', v),
      }),
      h(DatePicker, {
        modelValue: this.d1,
        'onUpdate:modelValue': (v: string) => {
          this.d1 = v;
        },
        onApply: (v: string) => this.onApply('d1', v),
      }),
      h(DatePicker, {
        modelValue: this.d2,
        'onUpdate:modelValue': (v: string) => {
          this.d2 = v;
        },
        onApply: (v: string) => this.onApply('d2', v),
      }),
      h(DatePicker, {
        modelValue: this.d3,
        'onUpdate:modelValue': (v: string) => {
          this.d3 = v;
        },
        onApply: (v: string) => this.onApply('d3', v),
      }),
    ]);
  },
});

it('test_app_integration_date_fields_and_filter', async () => {
  const wrapper = mount(Host);
  const fields = wrapper.findAllComponents(DatePicker);

  // 全 App 日期控件 ≥4，且每个都有 📅 按钮
  expect(fields.length).toBeGreaterThanOrEqual(4);
  for (const f of fields) {
    expect(f.find('.dp-btn-calendar').text()).toContain('📅');
  }

  // 弹层实例独立：只打开第 0 个，其它实例无弹层
  await fields[0].find('.dp-btn-calendar').trigger('click');
  expect(fields[0].find('.dp-popup').exists()).toBe(true);
  expect(fields[1].find('.dp-popup').exists()).toBe(false);
  expect(fields[2].find('.dp-popup').exists()).toBe(false);
  expect(fields[3].find('.dp-popup').exists()).toBe(false);

  // 点某天 → v-model 回填 + 触发 apply（FilterPanel 收到即重筛）
  const day15 = fields[0].findAll('.dp-day').find((b: any) => b.text() === '15');
  expect(day15).toBeTruthy();
  await day15!.trigger('click');
  expect(wrapper.vm.d0).toBe('2026-09-15');
  expect(wrapper.vm.log).toContain('d0:2026-09-15');
  // 其它实例不受影响
  expect(wrapper.vm.d1).toBe('');
  expect(wrapper.vm.d2).toBe('');
  expect(wrapper.vm.d3).toBe('');

  // 日历「清除」→ 清空输入并再次触发 apply
  await fields[0].find('.dp-btn-calendar').trigger('click');
  await fields[0].find('.dp-clear').trigger('click');
  expect(wrapper.vm.d0).toBe('');
  expect(wrapper.vm.log).toContain('d0:');
  expect(wrapper.vm.d1).toBe('');
});
