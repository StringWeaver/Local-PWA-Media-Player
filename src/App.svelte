<script lang="ts">
  import { fly } from 'svelte/transition';
  import { getFfmpeg } from './lib/ffmpeg';
  import { fetchFile } from '@ffmpeg/util';

  import { snackbar } from 'mdui/functions/snackbar.js';
  import { confirm } from 'mdui/functions/confirm.js';
  import 'mdui/components/layout.js';
  import 'mdui/components/layout-main.js';
  import 'mdui/components/top-app-bar.js';
  import 'mdui/components/top-app-bar-title.js';
  import 'mdui/components/button-icon.js';
  import 'mdui/components/button.js';
  import 'mdui/components/circular-progress.js';
  import 'mdui/components/card.js';
  import '@mdui/icons/arrow-back.js';
  import '@mdui/icons/menu.js';
  import '@mdui/icons/more-vert.js';
  import '@mdui/icons/subtitles.js';
  import '@mdui/icons/cloud-upload.js';
  import '@mdui/icons/error-outline.js';
  import '@mdui/icons/info.js';

  type View = 'home' | 'play';
  type AppState = 'IDLE' | 'CONVERTING' | 'PLAYING' | 'ERROR';
  type SubtitleTrack = { url: string; label: string; language: string };

  let view: View = $state('home');
  let appState: AppState = $state('IDLE');
  let videoUrl: string | null = $state(null);
  let subtitleTracks: SubtitleTrack[] = $state([]);
  let errorMessage: string = $state('');
  let progress: number = $state(0);
  let statusMessage: string = $state('');
  // Removed unused variable currentFile
  let isProcessingSubtitle: boolean = $state(false);
  let storageUsed: string = $state('');
  
  let fileInputRef: HTMLInputElement | undefined = $state();
  let subtitleInputRef: HTMLInputElement | undefined = $state();
  let videoRef: HTMLVideoElement | undefined = $state();
  
  let playbackTimer: ReturnType<typeof setInterval> | undefined;
  let currentFileNameForProgress = '';

  function showAlert(msg: string) {
    snackbar({ message: msg });
  }

  async function updateStorageEstimate() {
    if (!window.caches) return;
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
      storageUsed = displayStr;
    } catch(e) {
      console.error("Failed to estimate storage", e);
    }
  }

  $effect(() => {
    if (appState === 'IDLE') {
      updateStorageEstimate();
    }
  });

  $effect(() => {
    if (appState === 'PLAYING' && videoRef && currentFileNameForProgress) {
      // 恢复进度
      const savedProgress = localStorage.getItem(`progress_${currentFileNameForProgress}`);
      if (savedProgress && videoRef) {
         videoRef.currentTime = parseFloat(savedProgress);
      }

      // 开始记录进度
      playbackTimer = setInterval(() => {
         if (videoRef) {
             localStorage.setItem(`progress_${currentFileNameForProgress}`, videoRef.currentTime.toString());
         }
      }, 2000);
    }

    return () => {
       if (playbackTimer) {
          clearInterval(playbackTimer);
          playbackTimer = undefined;
       }
    };
  });

  async function promptClearCache() {
    try {
      await confirm({
        headline: "Clear Local Cache?",
        description: `This will delete all saved processed videos and free up ${storageUsed}. You will need to process them again next time.`,
        confirmText: "Clear Cache",
        cancelText: "Cancel",
      });
      await clearCache();
    } catch {
      // canceled
    }
  }

  async function clearCache() {
    if (!window.caches) {
       showAlert("Cache API not supported in this environment.");
       return;
    }
    try {
      await caches.delete('local-player-media');
      localStorage.removeItem('cached_media_files');
      updateStorageEstimate();
      showAlert("Cache cleared successfully!");
    } catch(e) {
      showAlert("Failed to clear cache.");
    }
  }

  async function enforceCacheLimit(currentFileName: string) {
    if (!window.caches) return;
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
  }

  async function isDirectory(file: File): Promise<boolean> {
    if (file.type === '') {
      try {
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(false);
          reader.onerror = () => {
            if (reader.error && reader.error.name === 'NotReadableError') {
              resolve(true);
            } else {
              resolve(false);
            }
          };
          reader.readAsArrayBuffer(file.slice(0, 1));
        });
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  async function handleFile(file: File) {
    if (!file) return;
    
    // macOS directory detection workaround
    const isDir = await isDirectory(file);
    if (isDir) {
      showAlert("Please select a video file, not a directory.");
      if (fileInputRef) {
        fileInputRef.value = '';
      }
      return;
    }

    const isMkv = file.name.toLowerCase().endsWith('.mkv');
    view = 'play';
    await processFile(file, isMkv);
  }

  async function processFile(file: File, isMkv: boolean) {
    currentFileNameForProgress = file.name;
    appState = 'CONVERTING';
    progress = 0;

    try {
      if (window.caches) {
        await enforceCacheLimit(file.name);
        
        const cache = await caches.open('local-player-media');
        const cacheVideoUrl = `/cache-media/${encodeURIComponent(file.name)}/video.mp4`;
        const cachedVideo = await cache.match(cacheVideoUrl);
        
        if (cachedVideo) {
          statusMessage = 'Loading processed video from local storage...';
          const diskBlob = await cachedVideo.blob();
          videoUrl = URL.createObjectURL(diskBlob);
          
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
          if (cachedSubs.length > 0) subtitleTracks = cachedSubs;
          appState = 'PLAYING';
          return;
        }
      }
      
      statusMessage = 'Loading FFmpeg core...';
      const ffmpeg = await getFfmpeg();

      ffmpeg.off('log', () => {});
      ffmpeg.off('progress', () => {});

      statusMessage = 'Mounting file to virtual file system...';
      let inputPath = 'input_media';
      let mounted = false;
      const mountDir = `/mnt_${Date.now()}`;
      
      try {
        await ffmpeg.createDir(mountDir);
        await ffmpeg.mount('WORKERFS' as any, { files: [file] }, mountDir);
        inputPath = `${mountDir}/${file.name}`;
        mounted = true;
      } catch (e) {
        console.warn('WORKERFS mount failed, falling back to MEMFS', e);
        statusMessage = 'Reading file into memory...';
        await ffmpeg.writeFile('input_media', await fetchFile(file));
      }

      statusMessage = 'Analyzing video stream (HEVC & Subtitles check)...';
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
      try {
        // Run a fast probe just to get stream info instead of reading the whole file
        await ffmpeg.exec(['-i', inputPath, '-vframes', '1', '-f', 'null', '-']);
      } catch (e) {}
      ffmpeg.off('log', logHandler);

      let extractedTracks: SubtitleTrack[] = [];
      let finalVideoUrl: string = '';

      if (subtitleStreams.length > 0) {
         statusMessage = `Extracting ${subtitleStreams.length} subtitle track(s)...`;
         for (const sub of subtitleStreams) {
           try {
             const outName = `sub_${sub.index}.vtt`;
             const subRet = await ffmpeg.exec(['-i', inputPath, '-map', `0:s:${sub.index}`, outName]);
             if (subRet === 0) {
               const subData = await ffmpeg.readFile(outName);
               const subBlob = new Blob([subData as Uint8Array], { type: 'text/vtt' });
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
          statusMessage = 'Remuxing MKV to MP4 format...';
        } else {
          statusMessage = 'Tagging HEVC stream to hvc1 for Safari compatibility...';
        }
        ffmpeg.on('progress', ({ progress: p }) => {
          progress = Math.max(0, Math.min(100, Math.round(p * 100)));
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

        statusMessage = 'Saving to local cache (clearing RAM)...';
        const data = await ffmpeg.readFile(outputName);
        
        await ffmpeg.deleteFile('output.mp4');
        const cacheVideoUrl = `/cache-media/${encodeURIComponent(file.name)}/video.mp4`;

        const blob = new Blob([data as Uint8Array], { type: 'video/mp4' });
        if (window.caches) {
           const cache = await caches.open('local-player-media');
           await cache.put(cacheVideoUrl, new Response(blob, { headers: { 'Content-Type': 'video/mp4' } }));
           const diskRes = await cache.match(cacheVideoUrl);
           const diskBlob = await diskRes?.blob() || blob;
           finalVideoUrl = URL.createObjectURL(diskBlob);
        } else {
           finalVideoUrl = URL.createObjectURL(blob);
        }
      } else {
        finalVideoUrl = URL.createObjectURL(file);
      }
      
      statusMessage = 'Finalizing...';
      if (window.caches) {
         const cache = await caches.open('local-player-media');
         for (let i = 0; i < extractedTracks.length; i++) {
            const track = extractedTracks[i];
            const trackBlobRes = await fetch(track.url); 
            const trackBlob = await trackBlobRes.blob();
            await cache.put(`/cache-media/${encodeURIComponent(file.name)}/sub_${i}.vtt`, new Response(trackBlob, { headers: { 'Content-Type': 'text/vtt' } }));
         }
      }
      
      if (mounted) {
        try { await ffmpeg.unmount(mountDir); } catch(e) {}
        try { await ffmpeg.deleteDir(mountDir); } catch(e) {}
      } else {
        await ffmpeg.deleteFile('input_media');
      }

      videoUrl = finalVideoUrl;
      if (extractedTracks.length > 0) {
        subtitleTracks = extractedTracks;
      }
      appState = 'PLAYING';

    } catch (err: any) {
      console.error(err);
      errorMessage = err.message || 'An error occurred during video processing.';
      appState = 'ERROR';
      
      try {
        const ffmpeg = await getFfmpeg();
        ['input_media', 'output.mp4'].forEach(async file => {
          try { await ffmpeg.deleteFile(file); } catch (e) {}
        });
      } catch (e) {}
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  }

  function handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      handleFile(target.files[0]);
    }
  }

  async function loadExternalSubtitle(file: File) {
    if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.ass')) {
       showAlert('Only .srt and .ass subtitles are supported.');
       return;
    }
    
    isProcessingSubtitle = true;
    try {
       const ffmpeg = await getFfmpeg();
       const inputName = `ext_${file.name.replace(/\s+/g, '_')}`;
       const outputName = `ext_${Date.now()}.vtt`;
       
       const mountDir = `/mnt_sub_${Date.now()}`;
       let inputPath = inputName;
       let mounted = false;

       try {
         await ffmpeg.createDir(mountDir);
         await ffmpeg.mount('WORKERFS' as any, { files: [file] }, mountDir);
         inputPath = `${mountDir}/${file.name}`;
         mounted = true;
       } catch (e) {
         console.warn('WORKERFS failed for subtitle, using MEMFS', e);
         await ffmpeg.writeFile(inputName, await fetchFile(file));
       }
       
       const ret = await ffmpeg.exec(['-i', inputPath, outputName]);
       
       if (ret === 0) {
           const subData = await ffmpeg.readFile(outputName);
           const subBlob = new Blob([subData as Uint8Array], { type: 'text/vtt' });
           subtitleTracks = [
               ...subtitleTracks,
               {
                   url: URL.createObjectURL(subBlob),
                   label: file.name,
                   language: 'unknown'
               }
           ];
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
       isProcessingSubtitle = false;
    }
  }

  function handleSubtitleChange(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      loadExternalSubtitle(target.files[0]);
      if (subtitleInputRef) {
         subtitleInputRef.value = '';
      }
    }
  }

  function goBack() {
    if (playbackTimer) {
       clearInterval(playbackTimer);
       playbackTimer = undefined;
    }
    currentFileNameForProgress = '';
    
    if (videoUrl) {
       URL.revokeObjectURL(videoUrl);
       videoUrl = null;
    }
    subtitleTracks.forEach(t => URL.revokeObjectURL(t.url));
    subtitleTracks = [];

    appState = 'IDLE';
    errorMessage = '';
    view = 'home';
    
    getFfmpeg().then(ffmpeg => {
      ['input_media', 'output.mp4'].forEach(async file => {
        try { await ffmpeg.deleteFile(file); } catch (e) {}
      });
    }).catch(() => {});
  }
</script>

<mdui-layout style="height: 100dvh; position: fixed; top: 0; left: 0; right: 0; bottom: 0; overscroll-behavior-y: none;" class="font-sans overflow-hidden bg-white dark:bg-[#121212]">
  
  <mdui-top-app-bar variant="center-aligned">
    {#if view === 'play' && appState === 'PLAYING'}
      <mdui-button-icon onclick={goBack}><mdui-icon-arrow-back></mdui-icon-arrow-back></mdui-button-icon>
    {:else}
      <mdui-button-icon style="opacity: 0; pointer-events: none;"><mdui-icon-menu></mdui-icon-menu></mdui-button-icon>
    {/if}
    
    <mdui-top-app-bar-title>Local Player</mdui-top-app-bar-title>
    
    {#if view === 'play' && appState === 'PLAYING'}
      <div class="flex items-center pr-2">
        {#if isProcessingSubtitle}
          <mdui-circular-progress style="width: 24px; height: 24px; margin-right: 8px;"></mdui-circular-progress>
        {:else}
          <input type="file" accept=".srt,.ass" bind:this={subtitleInputRef} onchange={handleSubtitleChange} class="hidden" />
          <mdui-button-icon onclick={() => subtitleInputRef?.click()}><mdui-icon-subtitles></mdui-icon-subtitles></mdui-button-icon>
        {/if}
      </div>
    {:else}
      <mdui-button-icon style="opacity: 0; pointer-events: none;"><mdui-icon-more-vert></mdui-icon-more-vert></mdui-button-icon>
    {/if}
  </mdui-top-app-bar>

  <mdui-layout-main class="w-full mx-auto p-4 flex flex-col items-center justify-center relative overflow-y-auto overflow-x-hidden" style="height: 100%; -webkit-overflow-scrolling: touch;">
    <div class="w-full flex-1 grid" style="place-items: center;">
      
      {#if view === 'home'}
        <div 
          in:fly={{ x: -100, duration: 300 }} 
          out:fly={{ x: -100, duration: 300 }} 
          class="w-full max-w-2xl px-4 flex flex-col items-center col-start-1 row-start-1"
        >
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <mdui-card
            ondragover={handleDragOver}
            ondrop={handleDrop}
            onclick={() => fileInputRef?.click()}
            style="width: 100%; padding: 4rem 2rem; display: flex; flex-direction: column; align-items: center; cursor: pointer;"
            variant="elevated"
          >
            <mdui-icon-cloud-upload style="font-size: 4rem; color: var(--mdui-color-primary);"></mdui-icon-cloud-upload>
            <h2 style="margin-top: 1rem; margin-bottom: 0.5rem; text-align: center;">Drag & drop your video here</h2>
            <p style="text-align: center; color: var(--mdui-color-on-surface-variant);">
              Supports MP4, WebM, and MKV files.
              MKV files will be locally remuxed to MP4 right in your browser securely.
            </p>
            <input 
              type="file" 
              bind:this={fileInputRef} 
              onchange={handleInputChange} 
              accept="video/*,.mkv" 
              class="hidden" 
            />
            <mdui-button style="margin-top: 2rem;">
              Browse Files
            </mdui-button>
          </mdui-card>

          {#if storageUsed}
            <div class="mt-8 flex items-center justify-between w-full max-w-sm px-6 py-4 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1A1A1A]">
               <div class="flex flex-col">
                   <span class="text-sm font-medium text-gray-800 dark:text-gray-200">Local Storage Used</span>
                   <span class="text-xs text-gray-500 dark:text-gray-400">{storageUsed}</span>
               </div>
               <mdui-button variant="tonal" onclick={promptClearCache}>Clear Cache</mdui-button>
            </div>
          {/if}
        </div>
      {/if}

      {#if view === 'play'}
        <div 
          in:fly={{ x: 100, duration: 300 }} 
          out:fly={{ x: 100, duration: 300 }} 
          class="w-full flex-1 flex flex-col items-center justify-center col-start-1 row-start-1"
        >
          {#if appState === 'CONVERTING'}
            <div class="w-full max-w-md p-8 flex flex-col items-center text-center">
               <mdui-circular-progress style="margin-bottom: 2rem; width: 64px; height: 64px;"></mdui-circular-progress>
               <h3 class="text-xl font-semibold mb-2">Processing Video</h3>
               <p class="text-gray-500 dark:text-gray-400 mb-6 min-h-[48px]">{statusMessage}</p>
               
               <div class="w-full relative pt-1">
                 <div class="flex mb-2 items-center justify-between">
                   <div>
                     <span class="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                       {progress}%
                     </span>
                   </div>
                 </div>
                 <div class="overflow-hidden h-2 mb-4 text-xs flex rounded-full bg-gray-100 dark:bg-gray-800">
                   <div style="width: {progress}%" class="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-blue-500 transition-all duration-300"></div>
                 </div>
               </div>
            </div>
          {/if}

          {#if appState === 'ERROR'}
             <div class="text-center p-8">
                <mdui-icon-error-outline style="font-size: 4rem; color: var(--mdui-color-error); margin-bottom: 1rem;"></mdui-icon-error-outline>
                <h3 class="text-xl font-semibold mb-2 text-red-600 dark:text-red-400">Processing Failed</h3>
                <p class="text-gray-600 dark:text-gray-300 mb-6 max-w-md">{errorMessage}</p>
                <mdui-button onclick={goBack} variant="filled">Go Back</mdui-button>
             </div>
          {/if}

          {#if appState === 'PLAYING'}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={videoRef}
              src={videoUrl}
              controls
              playsinline
              class="max-w-[80vw] max-h-[80vh] bg-black rounded-lg shadow-xl"
              style="width: fit-content; height: auto;"
            >
               {#each subtitleTracks as track, idx}
                 <track
                   kind="subtitles"
                   src={track.url}
                   srcLang={track.language}
                   label={track.label}
                   default={idx === 0}
                 />
               {/each}
            </video>
            <div class="mt-4 text-sm text-gray-500 dark:text-gray-400 flex items-center justify-center space-x-2">
               <mdui-icon-info style="font-size: 16px;"></mdui-icon-info>
               <span>Playing locally directly from browser</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </mdui-layout-main>
</mdui-layout>
