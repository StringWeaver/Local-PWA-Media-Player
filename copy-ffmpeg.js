import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

const copyIfExist = (src, dest) => {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${src} to ${dest}`);
  }
}

// core
copyIfExist(path.join(__dirname, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.js'), path.join(publicDir, 'ffmpeg-core.js'));
copyIfExist(path.join(__dirname, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.wasm'), path.join(publicDir, 'ffmpeg-core.wasm'));
