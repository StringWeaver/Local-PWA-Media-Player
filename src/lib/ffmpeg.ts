import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpegInstance: FFmpeg | null = null;
let isLoading = false;

export const getFfmpeg = async (): Promise<FFmpeg> => {
    if (ffmpegInstance) return ffmpegInstance;
    
    // Wait until any existing loading finishes to avoid race conditions
    if (isLoading) {
        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (ffmpegInstance) {
                    clearInterval(check);
                    resolve(ffmpegInstance);
                }
            }, 100);
        });
    }

    isLoading = true;
    try {
        const ffmpeg = new FFmpeg();
        console.log("Loading FFmpeg from public");
        
        ffmpeg.on('log', ({ message }) => {
            console.log("FFmpeg init:", message);
        });

        const baseURL = window.location.origin;
        console.log("Fetching coreURL from", baseURL + '/ffmpeg-core.js');
        const coreURL = await toBlobURL(baseURL + '/ffmpeg-core.js', 'text/javascript');
        console.log("Fetching wasmURL from", baseURL + '/ffmpeg-core.wasm');
        const wasmURL = await toBlobURL(baseURL + '/ffmpeg-core.wasm', 'application/wasm');

        console.log("Loading FFmpeg.load()...");
        await ffmpeg.load({
            coreURL,
            wasmURL,
        });
        console.log("FFmpeg loaded successfully");
        ffmpegInstance = ffmpeg;
        return ffmpeg;
    } catch (err) {
        console.error("FFmpeg load failed:", err);
        throw err;
    } finally {
        isLoading = false;
    }
};
