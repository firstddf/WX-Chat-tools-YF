import { createApp } from 'vue';
import App from './App.vue';
import { createIpc, IPC_KEY } from './ipc/context';
import './styles/app.css';

// 生产（Tauri 壳内）→ TauriIpc；普通浏览器（vite dev / 测试）→ MockIpc（docs/02 §6）
const app = createApp(App);
app.provide(IPC_KEY, createIpc());
app.mount('#app');
