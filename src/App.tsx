import React, { useState, useRef, useEffect, DragEvent, ChangeEvent } from 'react';
import { Routes, Route, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { getFfmpeg } from './lib/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

type AppState = 'IDLE' | 'CONVERTING' | 'PLAYING' | 'ERROR';

type SubtitleTrack = { url: string; label: string; language: string };

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [isProcessingSubtitle, setIsProcessingSubtitle] = useState<boolean>(false);
  const [storageUsed, setStorageUsed] = useState<string>('');
  const [snackbarMessage, setSnackbarMessage] = useState<string>('');
  const [isConfirmClearCacheOpen, setIsConfirmClearCacheOpen] = useState(false);

  const showAlert = (msg: string) => setSnackbarMessage(msg);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSaveRef = useRef<number>(0);

  const updateStorageEstimate = async () => {
      try {
          let totalBytes = 0;
          const cache = await caches.open('local-player-media');
          const keys = await cache.keys();
          for (const req of keys) {
              const res = await cache.match(req);
              if (res) {
                  const blob = await res.blob();
                  totalBytes += blob.size;
              }
          }
          const mb = totalBytes / 1024 / 1024;
          let displayStr = mb.toFixed(1) + ' MB';
          if (mb > 1024) displayStr = (mb / 1024).toFixed(2) + ' GB';
          setStorageUsed(displayStr);
      } catch(e) {
          console.error("Failed to estimate storage", e);
      }
  };

  useEffect(() => {
     if (appState === 'IDLE') updateStorageEstimate();
  }, [appState]);

  const clearCache = async () => {
      try {
          await caches.delete('local-player-media');
          localStorage.removeItem('cached_media_files');
          updateStorageEstimate();
          showAlert("Cache cleared successfully!");
      } catch(e) {
          showAlert("Failed to clear cache.");
      }
      setIsConfirmClearCacheOpen(false);
  };

  const enforceCacheLimit = async (currentFileName: string) => {
    try {
        const cache = await caches.open('local-player-media');
        const keys = await cache.keys();
        const files = new Set<string>();
        keys.forEach(req => {
            const match = req.url.match(/\/cache-media\/([^/]+)\//);
            if (match) files.add(decodeURIComponent(match[1]));
        });
        
        let storedNames: string[] = JSON.parse(localStorage.getItem('cached_media_files') || '[]');
        storedNames = storedNames.filter(n => files.has(n));
        
        if (!storedNames.includes(currentFileName)) {
            storedNames.push(currentFileName);
        } else {
             storedNames = storedNames.filter(n => n !== currentFileName);
             storedNames.push(currentFileName);
        }

        while (storedNames.length > 2) {
            const toRemove = storedNames.shift();
            if (toRemove) {
                for (const req of keys) {
                    if (req.url.includes(`/cache-media/${encodeURIComponent(toRemove)}/`)) {
                        await cache.delete(req);
                    }
                }
            }
        }
        localStorage.setItem('cached_media_files', JSON.stringify(storedNames));
    } catch(e) {
        console.error("Cache limit enforcement failed", e);
    }
  };

  const handleFile = async (file: File) => {
    if (!file) return;
    
    // Check if browser natively supports the file
    // .mp4, .webm, .m4v are usually supported directly
    const isMkv = file.name.toLowerCase().endsWith('.mkv');
    
    navigate('/play');
    await processFile(file, isMkv);
  };

  const processFile = async (file: File, isMkv: boolean) => {
    setCurrentFile(file);
    setAppState('CONVERTING');
    setProgress(0);

    try {
      await enforceCacheLimit(file.name);
      
      const cache = await caches.open('local-player-media');
      const cacheVideoUrl = `/cache-media/${encodeURIComponent(file.name)}/video.mp4`;
      const cachedVideo = await cache.match(cacheVideoUrl);
      
      if (cachedVideo) {
        setStatusMessage('Loading processed video from local storage...');
        const diskBlob = await cachedVideo.blob();
        setVideoUrl(URL.createObjectURL(diskBlob));
        
        const cachedSubs: { url: string; label: string; language: string }[] = [];
        let subIdx = 0;
        while (true) {
          const subRes = await cache.match(`/cache-media/${encodeURIComponent(file.name)}/sub_${subIdx}.vtt`);
          if (!subRes) break;
           const subBlob = await subRes.blob();
           cachedSubs.push({
             url: URL.createObjectURL(subBlob),
             label: `Track ${subIdx + 1}`,
             language: `sub_${subIdx}`
           });
           subIdx++;
        }
        if (cachedSubs.length > 0) setSubtitleTracks(cachedSubs);
        setAppState('PLAYING');
        return;
      }
      
      setStatusMessage('Loading FFmpeg core...');
      const ffmpeg = await getFfmpeg();

      // Clean up previous listeners
      ffmpeg.off('log', () => {});
      ffmpeg.off('progress', () => {});

      setStatusMessage('Mounting file to virtual file system...');
      let inputPath = 'input_media';
      let mounted = false;
      const mountDir = `/mnt_${Date.now()}`;
      
      try {
        await ffmpeg.createDir(mountDir);
        await ffmpeg.mount('WORKERFS', { files: [file] }, mountDir);
        inputPath = `${mountDir}/${file.name}`;
        mounted = true;
      } catch (e) {
        console.warn('WORKERFS mount failed, falling back to MEMFS', e);
        setStatusMessage('Reading file into memory...');
        await ffmpeg.writeFile('input_media', await fetchFile(file));
      }

      setStatusMessage('Analyzing video stream (HEVC & Subtitles check)...');
      let isHevc = false;
      let subtitleStreams: { index: number, language: string }[] = [];
      let subCount = 0;
      const logHandler = ({ message }: { message: string }) => {
        if (message.toLowerCase().includes('hevc')) {
           isHevc = true;
        }
        const subMatch = message.match(/Stream #\d+:\d+(?:\[.*?\])?(?:\(([a-zA-Z]+)\))?: Subtitle:/i);
        if (subMatch) {
           const lang = subMatch[1] || 'Unknown';
           subtitleStreams.push({ index: subCount, language: lang });
           subCount++;
        }
      };
      
      ffmpeg.on('log', logHandler);
      // Dummy run to analyze stream formats
      try {
        await ffmpeg.exec(['-i', inputPath, '-c:v', 'copy', '-f', 'null', '-']);
      } catch (e) {
        // Expected to potentially throw, but usually it gathers info
      }
      ffmpeg.off('log', logHandler);

      let extractedTracks: SubtitleTrack[] = [];
      let finalVideoUrl: string = '';

      if (subtitleStreams.length > 0) {
         setStatusMessage(`Extracting ${subtitleStreams.length} subtitle track(s)...`);
         for (const sub of subtitleStreams) {
           try {
             const outName = `sub_${sub.index}.vtt`;
             const subRet = await ffmpeg.exec(['-i', inputPath, '-map', `0:s:${sub.index}`, outName]);
             if (subRet === 0) {
               const subData = await ffmpeg.readFile(outName);
               const subBlob = new Blob([subData], { type: 'text/vtt' });
               extractedTracks.push({
                 url: URL.createObjectURL(subBlob),
                 label: `Track ${sub.index + 1} (${sub.language})`,
                 language: sub.language
               });
               await ffmpeg.deleteFile(outName);
             }
           } catch(e) {
             console.error(`Subtitle extraction failed for track ${sub.index}`, e);
           }
         }
      }

      if (isMkv || isHevc) {
        if (isMkv) {
          setStatusMessage('Remuxing MKV to MP4 format...');
        } else {
          setStatusMessage('Tagging HEVC stream to hvc1 for Safari compatibility...');
        }
        ffmpeg.on('progress', ({ progress: p }) => {
          // Make sure progress is clamped between 0 and 1
          const percent = Math.max(0, Math.min(100, Math.round(p * 100)));
          setProgress(percent);
        });

        const outputName = 'output.mp4';
        const command = [
          '-i', inputPath,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-c:s', 'mov_text',
          '-map', '0:v?',
          '-map', '0:a?',
          '-map', '0:s?',
          '-metadata', 'encoding_tool=ffmpeg',
        ];
        if (isHevc) {
          command.push('-tag:v', 'hvc1');
        }
        command.push(outputName);

        const ret = await ffmpeg.exec(command);
        if (ret !== 0) {
           throw new Error("FFmpeg exited with non-zero code.");
        }

        setStatusMessage('Saving to local cache (clearing RAM)...');
        const data = await ffmpeg.readFile(outputName);
        
        await ffmpeg.deleteFile('output.mp4');

        const blob = new Blob([data], { type: 'video/mp4' });
        await cache.put(cacheVideoUrl, new Response(blob, { headers: { 'Content-Type': 'video/mp4' } }));
        const diskRes = await cache.match(cacheVideoUrl);
        const diskBlob = await diskRes?.blob() || blob;
        finalVideoUrl = URL.createObjectURL(diskBlob);
      } else {
        finalVideoUrl = URL.createObjectURL(file);
      }
      
      setStatusMessage('Finalizing...');
      for (let i = 0; i < extractedTracks.length; i++) {
         const track = extractedTracks[i];
         const trackBlobRes = await fetch(track.url); 
         const trackBlob = await trackBlobRes.blob();
         await cache.put(`/cache-media/${encodeURIComponent(file.name)}/sub_${i}.vtt`, new Response(trackBlob, { headers: { 'Content-Type': 'text/vtt' } }));
      }
      
      // Cleanup WASM memory
      if (mounted) {
        try { await ffmpeg.unmount(mountDir); } catch(e) {}
        try { await ffmpeg.deleteDir(mountDir); } catch(e) {}
      } else {
        await ffmpeg.deleteFile('input_media');
      }

      setVideoUrl(finalVideoUrl);
      if (extractedTracks.length > 0) {
        setSubtitleTracks(extractedTracks);
      }
      setAppState('PLAYING');

    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'An error occurred during video processing.');
      setAppState('ERROR');
      
      // Attempt to clean up lingering files on error
      try {
        const ffmpeg = await getFfmpeg();
        ['input_media', 'output.mp4'].forEach(async file => {
          try { await ffmpeg.deleteFile(file); } catch (e) {}
        });
      } catch (e) {}
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  };

  const loadExternalSubtitle = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.ass')) {
       showAlert('Only .srt and .ass subtitles are supported.');
       return;
    }
    
    setIsProcessingSubtitle(true);
    try {
       const ffmpeg = await getFfmpeg();
       const inputName = `ext_${file.name.replace(/\s+/g, '_')}`;
       const outputName = `ext_${Date.now()}.vtt`;
       
       const mountDir = `/mnt_sub_${Date.now()}`;
       let inputPath = inputName;
       let mounted = false;

       try {
         await ffmpeg.createDir(mountDir);
         await ffmpeg.mount('WORKERFS', { files: [file] }, mountDir);
         inputPath = `${mountDir}/${file.name}`;
         mounted = true;
       } catch (e) {
         console.warn('WORKERFS failed for subtitle, using MEMFS', e);
         await ffmpeg.writeFile(inputName, await fetchFile(file));
       }
       
       const ret = await ffmpeg.exec(['-i', inputPath, outputName]);
       
       if (ret === 0) {
           const subData = await ffmpeg.readFile(outputName);
           const subBlob = new Blob([subData], { type: 'text/vtt' });
           setSubtitleTracks(prev => [
               ...prev,
               {
                   url: URL.createObjectURL(subBlob),
                   label: file.name,
                   language: 'unknown'
               }
           ]);
           await ffmpeg.deleteFile(outputName);
       } else {
           showAlert('Failed to process external subtitle.');
       }
       
       if (mounted) {
         try { await ffmpeg.unmount(mountDir); } catch(e) {}
         try { await ffmpeg.deleteDir(mountDir); } catch(e) {}
       } else {
         await ffmpeg.deleteFile(inputName);
       }
    } catch(err) {
       console.error("External subtitle processing failed", err);
       showAlert('Error processing subtitle file.');
    } finally {
       setIsProcessingSubtitle(false);
    }
  };

  const handleSubtitleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadExternalSubtitle(e.target.files[0]);
      // Reset input value to allow selecting same file again
      if (subtitleInputRef.current) {
         subtitleInputRef.current.value = '';
      }
    }
  };

  const goBack = () => {
    if (videoUrl) {
       URL.revokeObjectURL(videoUrl);
       setVideoUrl(null);
    }
    subtitleTracks.forEach(t => URL.revokeObjectURL(t.url));
    setSubtitleTracks([]);
    setCurrentFile(null);
    setAppState('IDLE');
    setErrorMessage('');
    navigate('/');
    
    // Cleanup any lingering ffmpeg files
    getFfmpeg().then(ffmpeg => {
      ['input_media', 'output.mp4'].forEach(async file => {
        try { await ffmpeg.deleteFile(file); } catch (e) {}
      });
    }).catch(() => {});
  };

  return (
    <mdui-layout style={{ height: '100vh' }} className="font-sans overflow-hidden">
      
      <mdui-top-app-bar variant="center-aligned" style={{ backgroundColor: 'var(--mdui-color-surface-container)', alignItems: 'center' }} className="border-b border-black/5 dark:border-white/5">
        {location.pathname === '/play' && appState === 'PLAYING' ? (
          <mdui-button-icon icon="arrow_back" onClick={goBack} style={{ margin: 'auto 0' }}></mdui-button-icon>
        ) : (
          <mdui-button-icon icon="menu" style={{ opacity: 0, pointerEvents: 'none', margin: 'auto 0' }}></mdui-button-icon>
        )}
        <mdui-top-app-bar-title>Local Player</mdui-top-app-bar-title>
        
        {location.pathname === '/play' && appState === 'PLAYING' ? (
          <div className="flex items-center pr-2" style={{ margin: 'auto 0' }}>
            {isProcessingSubtitle ? (
                <mdui-circular-progress style={{ width: '24px', height: '24px', marginRight: '8px' }}></mdui-circular-progress>
            ) : (
                <>
                    <input type="file" accept=".srt,.ass" ref={subtitleInputRef} onChange={handleSubtitleChange} className="hidden" />
                    <mdui-button-icon icon="subtitles" onClick={() => subtitleInputRef.current?.click()}></mdui-button-icon>
                </>
            )}
          </div>
        ) : (
          <mdui-button-icon icon="more_vert" style={{ opacity: 0, pointerEvents: 'none', margin: 'auto 0' }}></mdui-button-icon>
        )}
      </mdui-top-app-bar>
 
      <mdui-layout-main className="w-full max-w-screen-lg mx-auto p-4 flex flex-col items-center justify-center relative overflow-y-auto overflow-x-hidden" style={{ height: '100%' }}>
        <div className="w-full flex-1 grid" style={{ placeItems: 'center' }}>
          <AnimatePresence initial={false}>
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={
                <motion.div 
                  initial={{ x: '-100%' }} 
                  animate={{ x: 0 }} 
                  exit={{ x: '-100%' }} 
                  transition={{ duration: 0.3, ease: 'easeInOut' }} 
                  className="w-full max-w-2xl px-4 flex flex-col items-center col-start-1 row-start-1"
                >
                <mdui-card
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ width: '100%', padding: '4rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
                  variant="elevated"
                >
                  <mdui-icon name="cloud_upload" style={{ fontSize: '4rem', color: 'var(--mdui-color-primary)' }}></mdui-icon>
                  <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', textAlign: 'center' }}>Drag & drop your video here</h2>
                  <p style={{ textAlign: 'center', color: 'var(--mdui-color-on-surface-variant)' }}>
                    Supports MP4, WebM, and MKV files.
                    MKV files will be locally remuxed to MP4 right in your browser securely.
                  </p>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleInputChange} 
                    accept="video/*,.mkv" 
                    className="hidden" 
                  />
                  <mdui-button style={{ marginTop: '2rem' }}>
                    Browse Files
                  </mdui-button>
                </mdui-card>

                {storageUsed && (
                    <div className="mt-8 flex items-center justify-between w-full max-w-sm px-6 py-4 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1A1A1A]">
                       <div className="flex flex-col">
                           <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Local Storage Used</span>
                           <span className="text-xs text-gray-500 dark:text-gray-400">{storageUsed}</span>
                       </div>
                       <mdui-button variant="tonal" onClick={() => setIsConfirmClearCacheOpen(true)}>Clear Cache</mdui-button>
                    </div>
                )}
                </motion.div>
              } />

              <Route path="/play" element={
                <motion.div 
                  initial={{ x: '100%' }} 
                  animate={{ x: 0 }} 
                  exit={{ x: '100%' }} 
                  transition={{ duration: 0.3, ease: 'easeInOut' }} 
                  className="w-full flex-1 flex flex-col items-center justify-center col-start-1 row-start-1"
                >
                  {appState === 'IDLE' && <Navigate to="/" replace />}
                
                {appState === 'CONVERTING' && (
                  <div className="flex flex-col items-center justify-center w-full max-w-md p-8">
                    <mdui-circular-progress style={{ marginBottom: '2rem' }}></mdui-circular-progress>
                    <h2 className="text-lg font-medium mb-2">Processing Video</h2>
                    <p className="text-sm text-center mb-6" style={{ color: 'var(--mdui-color-on-surface-variant)' }}>
                      {statusMessage || 'Preparing...'}
                    </p>
                    <mdui-linear-progress value={progress} max="100" style={{ width: '100%' }}></mdui-linear-progress>
                    <p style={{ marginTop: '1rem' }}>{progress}%</p>
                  </div>
                )}

                {appState === 'ERROR' && (
                  <div className="flex flex-col items-center justify-center w-full max-w-md p-8">
                    <mdui-icon name="error" style={{ fontSize: '4rem', color: 'var(--mdui-color-error)', marginBottom: '1rem' }}></mdui-icon>
                    <h2 className="text-xl font-medium mb-2">Error Processing Video</h2>
                    <p className="text-sm text-center mb-8" style={{ color: 'var(--mdui-color-error)' }}>
                      {errorMessage}
                    </p>
                    <mdui-button variant="outlined" onClick={goBack}>
                      Go Back
                    </mdui-button>
                  </div>
                )}

                {appState === 'PLAYING' && videoUrl && (
                  <div className="w-full flex-1 flex flex-col w-full max-w-5xl pt-4">
                    
                    <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-2xl">
                      <video
                        ref={videoRef}
                        src={videoUrl}
                        controls
                        autoPlay
                        crossOrigin="anonymous"
                        className="w-full h-full outline-none"
                        onLoadedMetadata={() => {
                          if (currentFile && videoRef.current) {
                              const key = `video_progress_${currentFile.name}_${currentFile.size}`;
                              const savedTime = localStorage.getItem(key);
                              if (savedTime && !isNaN(Number(savedTime))) {
                                  videoRef.current.currentTime = Number(savedTime);
                              }
                          }
                        }}
                        onTimeUpdate={() => {
                           const now = Date.now();
                           if (now - lastSaveRef.current > 2000 && videoRef.current && currentFile) {
                               const key = `video_progress_${currentFile.name}_${currentFile.size}`;
                               // Only save if we are past the very beginning
                               if (videoRef.current.currentTime > 0) {
                                   localStorage.setItem(key, videoRef.current.currentTime.toString());
                               }
                               lastSaveRef.current = now;
                           }
                        }}
                      >
                        {subtitleTracks.map((track, idx) => (
                          <track 
                            key={idx} 
                            kind="subtitles" 
                            src={track.url} 
                            srcLang={track.language} 
                            label={track.label} 
                            default={idx === 0} 
                          />
                        ))}
                        Your browser does not support the video tag.
                      </video>
                    </div>
                  </div>
                  )}
                </motion.div>
              } />
            </Routes>
          </AnimatePresence>
        </div>
      </mdui-layout-main>

      {snackbarMessage && (
        <mdui-snackbar 
           open 
           onClosed={() => setSnackbarMessage('')}
        >
           {snackbarMessage}
        </mdui-snackbar>
      )}

      {isConfirmClearCacheOpen && (
        <mdui-dialog 
           open
           onClosed={() => setIsConfirmClearCacheOpen(false)}
           headline="Clear Cache"
           close-on-overlay-click
        >
           Are you sure you want to clear all cached videos and subtitles?
           <div slot="action">
              <mdui-button variant="text" onClick={() => setIsConfirmClearCacheOpen(false)}>Cancel</mdui-button>
              <mdui-button variant="filled" onClick={clearCache}>Clear</mdui-button>
           </div>
        </mdui-dialog>
      )}
    </mdui-layout>
  );
}
