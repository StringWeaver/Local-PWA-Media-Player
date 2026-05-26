import { mount } from 'svelte';
import Framework7 from 'framework7/lite-bundle';
import Framework7Svelte from 'framework7-svelte';
import App from './App.svelte';
import './index.css';
import 'framework7/css/bundle';
import 'framework7-icons/css/framework7-icons.css';

Framework7.use(Framework7Svelte);

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
