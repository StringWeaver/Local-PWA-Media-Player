import { mount } from 'svelte';
import 'mdui/mdui.css';
import 'mdui';
import App from './App.svelte';

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