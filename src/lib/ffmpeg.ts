import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

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
