<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { snackbar } from 'mdui/functions/snackbar.js';
  import '@mdui/icons/arrow-back.js';
  import '@mdui/icons/subtitles.js';
  import '@mdui/icons/video-file--outlined.js';
  import '@mdui/icons/warning.js';
  import '@mdui/icons/info.js';
  import '@mdui/icons/download.js';
  import { getFfmpeg } from './lib/ffmpeg';
  type ViewState = 'home' | 'play';
  type AppState = 'IDLE' | 'CONVERTING' | 'PLAYING' | 'ERROR';
  type SubtitleTrack = { url: string; label: string; language: string };

  let view: ViewState = $state('home');
  let appState: AppState = $state('IDLE');
  let videoUrl: string | null = $state(null);
  let subtitleTracks: SubtitleTrack[] = $state([]);
  let errorMessage: string = $state('');
  let progress: number = $state(0);
  let statusMessage: string = $state('');
  let isProcessingSubtitle: boolean = $state(false);
  let storageUsed: string = $state('');

  let fileInputRef: HTMLInputElement | undefined = $state();
  let subtitleInputRef: HTMLInputElement | undefined = $state();
  let videoRef: HTMLVideoElement | undefined = $state();
  
  let playbackTimer: ReturnType<typeof setInterval> | undefined;
  let currentFileNameForProgress = '';

  let dialogOpened = $state(false);
  let dialogTitle = $state('');
  let dialogMessage = $state('');
  let dialogConfirmAction: (() => void) | null = $state(null);

  function showAlert(msg: string) {
    snackbar({ message: msg, placement: 'bottom' });
  }

  $effect(() => {
    if (appState === 'IDLE') {
      updateStorageEstimate();
    }
  });

  async function updateStorageEstimate() {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      let totalBytes = 0;
      // @ts-ignore
      for await (const name of opfsRoot.keys()) {
        if (name.startsWith('cache_media_')) {
          const dir = await opfsRoot.getDirectoryHandle(name);
          // @ts-ignore
          for await (const fileName of dir.keys()) {
            const fileHandle = await dir.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            totalBytes += file.size;
          }
        }
      }
      if (totalBytes === 0) {
        storageUsed = 'Empty';
        return;
      }
      const mb = totalBytes / 1024 / 1024;
      let displayStr = mb.toFixed(1) + ' MB';
      if (mb > 1024) displayStr = (mb / 1024).toFixed(2) + ' GB';
      storageUsed = displayStr;
    } catch(e) {
      console.error("Failed to estimate storage", e);
      storageUsed = 'Unknown';
    }
  }

  $effect(() => {
    if (appState === 'PLAYING' && videoRef && currentFileNameForProgress) {
      const savedProgress = localStorage.getItem(`progress_${currentFileNameForProgress}`);

      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const handleLoadedData = () => {
        if (savedProgress && videoRef) {
          progressTimer = setTimeout(() => {
            if (videoRef) {
              videoRef.currentTime = parseFloat(savedProgress);
            }
          }, 500);
        }
      };
      
      videoRef.addEventListener('loadeddata', handleLoadedData);

      playbackTimer = setInterval(() => {
         if (videoRef && !videoRef.paused) {
             localStorage.setItem(`progress_${currentFileNameForProgress}`, videoRef.currentTime.toString());
         }
      }, 2000);
      
      return () => {
        if (videoRef) {
          videoRef.removeEventListener('loadeddata', handleLoadedData);
        }
        if (progressTimer) {
          clearTimeout(progressTimer);
          progressTimer = undefined;
        }
        if (playbackTimer) {
          clearInterval(playbackTimer);
          playbackTimer = undefined;
        }
      };
    }
  });

  function promptClearCache() {
    dialogTitle = "Clear Local Cache?";
    dialogMessage = `This will delete all saved processed videos and free up ${storageUsed}. You will need to process them again next time.`;
    dialogConfirmAction = confirmClearCache;
    dialogOpened = true;
  }

  async function confirmClearCache() {
    dialogOpened = false;
    await clearCache();
  }

  async function clearCache() {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      // @ts-ignore
      for await (const name of opfsRoot.keys()) {
        if (name.startsWith('cache_media_')) {
          await opfsRoot.removeEntry(name, { recursive: true });
        }
      }
      localStorage.removeItem('cached_media_files');
      updateStorageEstimate();
      showAlert("Cache cleared successfully!");
    } catch(e) {
      showAlert("Failed to clear cache.");
    }
  }

  function promptClearAllData() {
    dialogTitle = "Clear All Data?";
    dialogMessage = "This will delete ALL local data including cached videos, playback progress, and settings. The page will reload. This cannot be undone.";
    dialogOpened = true;
    // Override the confirm handler for this prompt
    dialogConfirmAction = confirmClearAllData;
  }

  async function confirmClearAllData() {
    dialogOpened = false;
    try {
      // Clear OPFS
      const opfsRoot = await navigator.storage.getDirectory();
      // @ts-ignore
      for await (const name of opfsRoot.keys()) {
        try { await opfsRoot.removeEntry(name, { recursive: true }); } catch(e) {}
      }
      // Clear localStorage
      localStorage.clear();
      // Clear Cache Storage
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      // Clear IndexedDB
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map(db => {
        return new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(db.name!);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        });
      }));
      // Reload page
      window.location.reload();
    } catch(e) {
      showAlert("Failed to clear all data.");
    }
  }

  async function enforceCacheLimit(currentFileName: string) {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      let storedNames: string[] = JSON.parse(localStorage.getItem('cached_media_files') || '[]');
      
      const existingPrefixes = new Set<string>();
      // @ts-ignore
      for await (const name of opfsRoot.keys()) {
        if (name.startsWith('cache_media_')) {
          existingPrefixes.add(name.replace('cache_media_', ''));
        }
      }
      
      storedNames = storedNames.filter(n => existingPrefixes.has(encodeURIComponent(n)));
      
      if (!storedNames.includes(currentFileName)) {
        storedNames.push(currentFileName);
      } else {
        storedNames = storedNames.filter(n => n !== currentFileName);
        storedNames.push(currentFileName);
      }

      while (storedNames.length > 2) {
        const toRemove = storedNames.shift();
        if (toRemove) {
          const dirName = `cache_media_${encodeURIComponent(toRemove)}`;
          try {
            await opfsRoot.removeEntry(dirName, { recursive: true });
          } catch(e) {}
        }
      }
      localStorage.setItem('cached_media_files', JSON.stringify(storedNames));
    } catch(e) {
      console.error("Cache limit enforcement failed", e);
    }
  }

  async function handleFile(file: File) {
    console.log('[handleFile] received:', file?.name);
    if (!file) {
      console.log('[handleFile] no file, returning');
      return;
    }
    const isMkv = file.name.toLowerCase().endsWith('.mkv');
    console.log('[handleFile] setting view = play, isMkv:', isMkv);
    view = 'play';
    await processFile(file, isMkv);
  }

  async function processFile(file: File, isMkv: boolean) {
    console.log('[processFile] starting:', file.name, 'isMkv:', isMkv);
    currentFileNameForProgress = file.name;
    appState = 'CONVERTING';
    progress = 0;
    
    let mounted = false;
    const mountDir = `/mnt_${Date.now()}`;

    try {
      await enforceCacheLimit(file.name);
      
      const opfsRoot = await navigator.storage.getDirectory();
      const dirName = `cache_media_${encodeURIComponent(file.name)}`;
      
      try {
        const cacheDir = await opfsRoot.getDirectoryHandle(dirName);
        const videoHandle = await cacheDir.getFileHandle('video.mp4');
        
        statusMessage = 'Loading processed video from local storage...';
        const diskBlob = await videoHandle.getFile();
        videoUrl = URL.createObjectURL(diskBlob);
        
        const cachedSubs: { url: string; label: string; language: string }[] = [];
        let subIdx = 0;
        while (true) {
          try {
            const subHandle = await cacheDir.getFileHandle(`sub_${subIdx}.vtt`);
            const subBlob = await subHandle.getFile();
            cachedSubs.push({
              url: URL.createObjectURL(subBlob),
              label: `Track ${subIdx + 1}`,
              language: `sub_${subIdx}`
            });
            subIdx++;
          } catch(e) {
            break;
          }
        }
        if (cachedSubs.length > 0) subtitleTracks = cachedSubs;
        appState = 'PLAYING';
        return;
      } catch (e) {
        // Cache miss, continue to process
      }
      
      statusMessage = 'Loading FFmpeg core...';
      const ffmpeg = await getFfmpeg();

      ffmpeg.off('log', () => {});
      ffmpeg.off('progress', () => {});

      statusMessage = 'Mounting file to virtual file system...';
      let inputPath = 'input_media';
      
      try {
        await ffmpeg.createDir(mountDir);
        await ffmpeg.mount('WORKERFS' as any, { files: [file] }, mountDir);
        inputPath = `${mountDir}/${file.name}`;
        mounted = true;
      } catch (e) {
        console.error('WORKERFS mount failed. Fallback disabled.', e);
        throw e;
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
        // Only probe metadata (extremely fast, no decoding required)
        await ffmpeg.exec(['-hide_banner', '-i', inputPath]);
      } catch (e) {
        // Error is expected because no output file was specified, 
        // but logHandler will have already captured the stream info.
        console.info('FFmpeg metadata probe (expected error):', e);
      }
      ffmpeg.off('log', logHandler);

      let extractedTracks: SubtitleTrack[] = [];
      let finalVideoUrl: string = '';
      
      const cacheDir = await opfsRoot.getDirectoryHandle(dirName, { create: true });

      if (subtitleStreams.length > 0) {
         statusMessage = `Extracting ${subtitleStreams.length} subtitle track(s)...`;
         
         const extractArgs: string[] = ['-i', inputPath];
         const outNames: string[] = [];

         for (const sub of subtitleStreams) {
            const outName = `sub_${sub.index}.vtt`;
            outNames.push(outName);
            extractArgs.push('-map', `0:s:${sub.index}`, outName);
         }

         try {
            const subRet = await ffmpeg.exec(extractArgs);
            if (subRet === 0) {
               for (let i = 0; i < subtitleStreams.length; i++) {
                  const sub = subtitleStreams[i];
                  const outName = outNames[i];
                  const subData = await ffmpeg.readFile(outName);
                  const subBlob = new Blob([subData as Uint8Array], { type: 'text/vtt' });
                  
                  // Save subtitle to OPFS cache
                  const subHandle = await cacheDir.getFileHandle(`sub_${i}.vtt`, { create: true });
                  const subWritable = await subHandle.createWritable();
                  await subWritable.write(subBlob);
                  await subWritable.close();
                  
                  extractedTracks.push({
                     url: URL.createObjectURL(subBlob),
                     label: `Track ${sub.index + 1} (${sub.language})`,
                     language: sub.language
                  });
                  await ffmpeg.deleteFile(outName);
               }
            }
         } catch(e) {
            console.error('Subtitle extraction failed', e);
         }
      }

      statusMessage = 'Releasing FFmpeg memory...';
      if (mounted) {
        try { await ffmpeg.unmount(mountDir); } catch(e) {}
        try { await ffmpeg.deleteDir(mountDir); } catch(e) {}
      }
      mounted = false; // Prevent double cleanup later

      if (isMkv || isHevc) {
        statusMessage = 'Remuxing video to MP4 ...';
        
        const { Conversion, Input, Output, BlobSource, StreamTarget, Mp4OutputFormat, ALL_FORMATS } = await import('mediabunny');
        const input = new Input({
          source: new BlobSource(file),
          formats: ALL_FORMATS,
        });

        const fileHandle = await cacheDir.getFileHandle('video.mp4', { create: true });
        const writable = await fileHandle.createWritable();

        const output = new Output({
          format: new Mp4OutputFormat(),
          target: new StreamTarget(writable),
        });

        const conversion = await Conversion.init({
          input,
          output,
          video: (videoTrack) => {
             // Not setting `codec` forces a stream copy without transcoding
             const trackConfig: any = {};
             if (isHevc) {
                // Ensure hevc video stream is tagged with hvc1, bucause safari doesn't support hev1
                trackConfig.codec = 'hevc';
             }
             return trackConfig;
          },
          audio: (audioTrack) => ({})
        });

        conversion.onProgress = (p) => {
          progress = Math.max(0, Math.min(100, Math.round(p * 100)));
        };

        await conversion.execute();
        input.dispose();

        statusMessage = 'Finalizing OPFS file...';
        const finalFile = await fileHandle.getFile();
        finalVideoUrl = URL.createObjectURL(finalFile);
      } else {
        finalVideoUrl = URL.createObjectURL(file);
      }
      
      videoUrl = finalVideoUrl;
      if (extractedTracks.length > 0) {
        subtitleTracks = extractedTracks;
      }
      appState = 'PLAYING';

    } catch (err: any) {
      console.error("Error in processFile:", err);
      errorMessage = err.message || 'An error occurred during video processing.';
      appState = 'ERROR';
      
      try {
        const ffmpeg = await getFfmpeg();
        ['output.mp4'].forEach(async file => {
          try { await ffmpeg.deleteFile(file); } catch (e) {}
        });
      } catch (e) {}
    } finally {
      // Ensure we always clean up if an error occurred before the early cleanup
      if (mounted) {
        try {
          const ffmpeg = await getFfmpeg();
          await ffmpeg.unmount(mountDir);
          await ffmpeg.deleteDir(mountDir);
        } catch(e) {}
      }
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
    console.log('[handleInputChange] files:', target.files?.length);
    if (target.files && target.files.length > 0) {
      handleFile(target.files[0]);
    } else {
      console.log('[handleInputChange] no file selected');
    }
    target.value = ''; // Reset so same file can be selected again
  }

  async function loadExternalSubtitle(file: File) {
    if (!file.name.toLowerCase().endsWith('.srt') && !file.name.toLowerCase().endsWith('.ass')) {
       showAlert('Only .srt and .ass subtitles are supported.');
       return;
    }
    
    isProcessingSubtitle = true;
    let mounted = false;
    const mountDir = `/mnt_sub_${Date.now()}`;
    
    try {
       const ffmpeg = await getFfmpeg();
       const inputName = `ext_${file.name.replace(/\s+/g, '_')}`;
       const outputName = `ext_${Date.now()}.vtt`;
       
       let inputPath = inputName;

       try {
         await ffmpeg.createDir(mountDir);
         await ffmpeg.mount('WORKERFS' as any, { files: [file] }, mountDir);
         inputPath = `${mountDir}/${file.name}`;
         mounted = true;
       } catch (e) {
         console.error('WORKERFS mount failed. Fallback disabled.', e);
         throw e;
        //  const arrayBuffer = await file.arrayBuffer();
        //  await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));
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
    } catch(err) {
       console.error("External subtitle processing failed", err);
       showAlert('Error processing subtitle file.');
    } finally {
       isProcessingSubtitle = false;
       if (mounted) {
         try {
           const ffmpeg = await getFfmpeg();
           await ffmpeg.unmount(mountDir);
           await ffmpeg.deleteDir(mountDir);
         } catch(e) {}
       }
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

  function downloadVideo() {
    if (!videoUrl) return;
    const a = document.createElement('a');
    a.href = videoUrl;
    const baseName = currentFileNameForProgress.replace(/\.[^/.]+$/, "");
    a.download = baseName + ".mp4";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function goBack() {
    if (playbackTimer) {
       clearInterval(playbackTimer);
       playbackTimer = undefined;
    }
    currentFileNameForProgress = '';
    
    // Safely detach the video element before revoking URLs
    if (videoRef) {
       videoRef.pause();
       videoRef.removeAttribute('src');
       videoRef.load();
    }
    
    // Defer revoking to allow WebKit media engine to fully detach
    const urlsToRevoke = [];
    if (videoUrl) urlsToRevoke.push(videoUrl);
    subtitleTracks.forEach(t => urlsToRevoke.push(t.url));
    
    if (urlsToRevoke.length > 0) {
       setTimeout(() => {
          urlsToRevoke.forEach(url => URL.revokeObjectURL(url));
       }, 100);
    }
    
    videoUrl = null;
    subtitleTracks = [];

    appState = 'IDLE';
    errorMessage = '';
    view = 'home';
    
    getFfmpeg().then(ffmpeg => {
      ['output.mp4'].forEach(async file => {
        try { await ffmpeg.deleteFile(file); } catch (e) {}
      });
    }).catch(() => {});
  }
</script>

<!-- Home view: always rendered as base layer -->
<mdui-layout class="home-layout">
  <mdui-top-app-bar scroll-behavior="elevate" scroll-target=".home-layout mdui-layout-main">
    <mdui-top-app-bar-title>Local Player</mdui-top-app-bar-title>
  </mdui-top-app-bar>
  <mdui-layout-main>
    <div class="home-container">
    <mdui-card role="button" tabindex="0" variant="filled" clickable class="upload-card"
      ondragover={handleDragOver} ondrop={handleDrop} onclick={() => { console.log('[upload-card] clicked'); fileInputRef?.click(); }}
      onkeydown={(e) => e.key === 'Enter' && fileInputRef?.click()}>
      <mdui-icon-video-file--outlined class="upload-icon"></mdui-icon-video-file--outlined>
      <h2 class="upload-title">Select or drop video</h2>
      <p class="upload-desc">
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
      <mdui-button role="button" tabindex="0" variant="filled" class="pill-button" onclick={(e) => { e.stopPropagation(); fileInputRef?.click(); }} onkeydown={(e) => e.key === 'Enter' && fileInputRef?.click()}>Browse Files</mdui-button>
    </mdui-card>

    {#if storageUsed !== ''}
      <mdui-card variant="filled" class="storage-card">
         <div class="storage-info">
             <span class="storage-label">Local Storage Used</span>
             <span class="storage-value">{storageUsed}</span>
         </div>
         <div class="storage-actions">
           <mdui-button role="button" tabindex="0" variant="filled" class="pill-button" onclick={promptClearCache} onkeydown={(e) => e.key === 'Enter' && promptClearCache()}>Clear Cache</mdui-button>
           <mdui-button role="button" tabindex="0" variant="outlined" class="pill-button" onclick={promptClearAllData} onkeydown={(e) => e.key === 'Enter' && promptClearAllData()}>Clear All Data</mdui-button>
         </div>
      </mdui-card>
    {/if}
  </div>
  </mdui-layout-main>
</mdui-layout>

<!-- Play view: slides in from right, overlays on top of home -->
{#if view === 'play'}
  <div class="play-view-overlay" transition:fly={{ x: '100%', opacity: 1, duration: 350, easing: cubicOut }}>
    <mdui-layout class="play-layout">
      <mdui-top-app-bar scroll-behavior="elevate" scroll-target=".play-layout mdui-layout-main">
      {#if appState === 'PLAYING'}
        <mdui-button-icon role="button" tabindex="0" onclick={goBack} onkeydown={(e) => e.key === 'Enter' && goBack()}>
          <mdui-icon-arrow-back></mdui-icon-arrow-back>
        </mdui-button-icon>
      {/if}

      <mdui-top-app-bar-title>Local Player</mdui-top-app-bar-title>

      <div class="flex-spacer"></div>

      {#if appState === 'PLAYING'}
        <div class="top-bar-actions">
          {#if isProcessingSubtitle}
            <mdui-circular-progress class="subtitle-progress"></mdui-circular-progress>
          {:else}
            <input 
              type="file" 
              accept=".srt,.ass" 
              bind:this={subtitleInputRef} 
              onchange={handleSubtitleChange} 
              class="hidden" 
            />
          <mdui-button-icon role="button" tabindex="0" onclick={() => subtitleInputRef?.click()} onkeydown={(e) => e.key === 'Enter' && subtitleInputRef?.click()}>
            <mdui-icon-subtitles></mdui-icon-subtitles>
          </mdui-button-icon>
          {/if}
        </div>
      {/if}
    </mdui-top-app-bar>
      <mdui-layout-main>
        <div class="play-container">
        {#if appState === 'CONVERTING'}
          <mdui-dialog open headline="Processing Video" description={statusMessage} >
            <div class="dialog-progress-icon">
              <mdui-circular-progress></mdui-circular-progress>
            </div>
            <mdui-linear-progress value={progress / 100} max="1"></mdui-linear-progress>
          </mdui-dialog>
        {/if}

        {#if appState === 'ERROR'}
           <mdui-dialog open headline="Processing Failed" description={errorMessage} >
            <mdui-icon-warning slot="icon" class="dialog-error-icon"></mdui-icon-warning>
             <mdui-button role="button" tabindex="0" slot="action" variant="text" onclick={goBack} onkeydown={(e) => e.key === 'Enter' && goBack()}>Go Back</mdui-button>
           </mdui-dialog>
        {/if}

        {#if appState === 'PLAYING'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoRef}
            src={videoUrl}
            controls
            playsinline
            class="video-player"
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
          <div class="download-row">
             <mdui-button role="button" tabindex="0" variant="tonal" onclick={downloadVideo} onkeydown={(e) => e.key === 'Enter' && downloadVideo()}>
                <mdui-icon-download slot="icon"></mdui-icon-download>
                Export to MP4
             </mdui-button>
          </div>
        {/if}
      </div>
      </mdui-layout-main>
    </mdui-layout>
  </div>
{/if}

<mdui-dialog open={dialogOpened} headline={dialogTitle} description={dialogMessage} onclosed={() => dialogOpened = false} >
  <mdui-button role="button" tabindex="0" slot="action" variant="text" onclick={() => dialogOpened = false} onkeydown={(e) => e.key === 'Enter' && (dialogOpened = false)}>Cancel</mdui-button>
  <mdui-button role="button" tabindex="0" slot="action" variant="text" onclick={() => { dialogConfirmAction?.(); }} onkeydown={(e) => e.key === 'Enter' && dialogConfirmAction?.()}>OK</mdui-button>
</mdui-dialog>

<style>
  /* Hidden file inputs */
  .hidden { display: none; }

  /* Layout main area */
  :global(mdui-layout-main) {
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Home layout: fills viewport */
  :global(.home-layout) {
    position: fixed;
    inset: 0;
  }

  /* Play view overlay: z-index layer */
  .play-view-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgb(var(--mdui-color-surface));
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
  }

  /* Play layout: fills overlay */
  :global(.play-layout) {
    position: absolute;
    inset: 0;
  }

  /* Upload card container */
  .home-container {
    max-width: 40rem;
    width: 90%;
    margin: 2rem auto 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  :global(.upload-card) {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 3rem 1rem;
  }

  :global(.upload-icon) {
    font-size: 4rem;
    color: rgb(var(--mdui-color-primary));
  }

  .upload-title {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    font-size: var(--mdui-typescale-headline-small-size);
    font-weight: var(--mdui-typescale-title-medium-weight);
    text-align: center;
  }

  .upload-desc {
    text-align: center;
    color: rgb(var(--mdui-color-on-surface-variant));
    margin-bottom: 1.5rem;
    font-size: var(--mdui-typescale-body-medium-size);
  }

  /* Storage card */
  :global(.storage-card) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    gap: 0.75rem;
  }

  .storage-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 1;
  }

  /* Play container */
  .play-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1rem 0;
  }

  /* Video player */
  .video-player {
    max-width: 90vw;
    background: black;
    box-shadow: var(--mdui-elevation-level3);
    width: fit-content;
  }

  /* Flex spacer for top app bar */
  .flex-spacer { flex-grow: 1; }

  /* Top bar actions container */
  .top-bar-actions {
    display: flex;
    align-items: center;
  }

  /* Storage info */
  .storage-info {
    display: flex;
    flex-direction: column;
  }
  .storage-label {
    font-size: var(--mdui-typescale-body-medium-size);
    font-weight: var(--mdui-typescale-label-large-weight);
  }
  .storage-value {
    font-size: var(--mdui-typescale-body-small-size);
    color: rgb(var(--mdui-color-on-surface-variant));
  }

  /* Download button row */
  .download-row {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }

  /* Dialog progress icon */
  :global(.dialog-progress-icon) {
    display: flex;
    justify-content: center;
    margin-bottom: 1rem;
  }
  :global(.dialog-progress-icon mdui-circular-progress) {
    width: 4rem;
    height: 4rem;
  }

  /* Dialog error icon */
  :global(.dialog-error-icon) {
    font-size: 4rem;
    color: rgb(var(--mdui-color-error));
  }
</style>
