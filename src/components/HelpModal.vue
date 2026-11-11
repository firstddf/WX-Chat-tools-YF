<script setup lang="ts">
// 「帮助」弹窗（docs/07 #18，2026-11-11 发布准备）：**内置离线**静态帮助——
// 快速上手 / 三个页签 / 导出说明 / 常见问题 / 快捷键 / 隐私与许可。
// 内容全部随包分发，不联网、不依赖外部文件；Esc 与点遮罩关闭，监听挂/摘成对（A1 #10）。
import { onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-mask" data-testid="help_modal" @click.self="emit('close')">
    <div class="modal-card modal-wide" role="dialog" aria-label="帮助">
      <div class="modal-head">
        <span class="modal-title">帮助 · 微信聊天记录工具</span>
        <button type="button" class="f-btn" data-testid="help_close" @click="emit('close')">
          关闭
        </button>
      </div>
      <div class="modal-body" data-testid="help_body">
        <h4 data-testid="help_sec_quick">快速上手</h4>
        <ul>
          <li>1）顶部账号栏确认账号与数据目录 → 到「数据筛选」页点<b>「加载/刷新数据」</b>；</li>
          <li>2）用关键词 / 群号 / 日期 / 类型筛选，勾选要导出的消息；</li>
          <li>3）到<b>「导出」页</b>勾选会话、设时间范围与内容类型、选输出目录 → <b>「▶ 开始导出」</b>；</li>
          <li>4）完成后点「打开导出目录」，用浏览器打开 HTML 浏览页即可离线查看。</li>
        </ul>

        <h4>三个页签</h4>
        <ul>
          <li><b>导出</b>：本地数据包导出（会话多选 + 时间范围 + 内容类型 + 生成物 + 增量导出）；</li>
          <li><b>数据筛选</b>：按条件筛消息、勾选后导出选中 JSON / CSV、引用跳转、右键菜单；</li>
          <li><b>聊天数据管理</b>：会话树与单会话浏览、复制群号、自检、打开本地数据包回读。</li>
        </ul>

        <h4>导出说明</h4>
        <ul>
          <li><b>导出本地数据包</b>：全量导出（HTML 浏览页 + 附件副本 + 状态文件）；</li>
          <li><b>选择性导出</b>：只导所选会话 / 时间范围 / 内容类型，可单独关掉某类生成物；</li>
          <li><b>增量导出</b>：向<b>同一输出目录</b>再次导出时，跳过没有新消息的会话、附件不重复复制；</li>
          <li>进度条与日志在导出页底部；「打开最近数据」可一键回读上次的数据包。</li>
        </ul>

        <h4 data-testid="help_sec_faq">常见问题</h4>
        <ul>
          <li>
            <b>提示 KEY_NOT_FOUND「微信未运行或没登录」</b>：解密密钥只存在于已登录的微信进程内存里
            → 先启动并登录微信，再点加载/重试。
          </li>
          <li>
            <b>提示「没有发现微信账号目录」</b>：数据目录不在常见位置 → 账号栏
            <b>「选择数据目录」</b>手动指到微信数据根（可「恢复自动」）。
          </li>
          <li>
            <b>图片显示不出</b>：加载前勾选<b>「解析附件路径」</b>；图片按需解码，滚到视口才加载。
          </li>
          <li>
            <b>语音听不了</b>：语音原文是微信的 SILK 格式，当前版本未内置解码器，
            <b>暂不支持播放与转文字</b>（后续版本评估）。
          </li>
          <li>
            <b>消息多选怎么框选</b>：在「数据筛选」页<b>从气泡上按下</b>再拖动（行间隙、头像处不触发，
            与 Tk 版同口径）；「聊天数据管理」页是纯浏览视图，本身没有勾选。
          </li>
          <li>
            <b>杀软报毒 / 拦截</b>：安装包未签名，误报常见 → 见 README「安装与杀软白名单」。
          </li>
        </ul>

        <h4>快捷键</h4>
        <ul>
          <li><b>Ctrl/Cmd + A</b>：「导出」页 = 全选会话；输入框内 = 选中框内文字；</li>
          <li><b>Ctrl + C</b>：复制当前选中的消息文字；</li>
          <li><b>Esc</b>：关闭右键菜单 / 清空多选 / 关闭本弹窗；</li>
          <li>拖动可选中消息正文与附件名（界面骨架文字不可选，避免误全选）。</li>
        </ul>

        <h4>隐私与安全</h4>
        <ul>
          <li>微信数据<b>只读</b>访问，程序从不写入微信目录；</li>
          <li><b>不联网、不上传</b>：所有读取、解码、导出都在本机完成；</li>
          <li>解密密钥仅从微信进程内存读取，<b>不落盘、不写日志</b>；</li>
          <li>导出产物与截图等证据目录保存在你选择的位置，由你自己管理。</li>
        </ul>

        <h4>许可证</h4>
        <ul>
          <li>
            本软件采用 <b>PolyForm Noncommercial License 1.0.0</b>（仅限非商业用途），
            完整条款见仓库 <b>LICENSE</b> 文件。
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
