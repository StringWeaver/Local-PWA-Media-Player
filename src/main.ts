import { mount } from 'svelte';
import App from './App.svelte';
import './index.css';
import 'mdui/mdui.css';

// Register PWA service worker
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  }).catch(() => {});
}

const app = mount(App, {
  target: document.getElementById('root')!,
});

export default app;
