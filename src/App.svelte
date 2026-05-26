<script lang="ts">
  import { fly } from 'svelte/transition';
  import { getFfmpeg } from './lib/ffmpeg';
  import { fetchFile } from '@ffmpeg/util';
  import { App, View, Page, Navbar, NavLeft, NavTitle, NavRight, Link, Block, Card, CardContent, Button, Icon, Preloader, Progressbar, f7 } from 'framework7-svelte';

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

  let f7params = {
    name: 'Local Player',
    theme: 'md',
  };

  function showAlert(msg: string) {
    if (f7) {
      f7.toast.create({
        text: msg,
        closeTimeout: 3000,
        position: 'bottom',
      }).open();
    } else {
      alert(msg);
    }
  }

  async function updateStorageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      storageUsed = 'Unknown';
      return;
    }
    
    try {
      const estimate = await navigator.storage.estimate();
      const totalBytes = estimate.usage || 0;
      if (totalBytes === 0) {
        storageUsed = 'Unknown';
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
    if (appState === 'IDLE') {
      updateStorageEstimate();
    }
  });

  $effect(() => {
    if (appState === 'PLAYING' && videoRef && currentFileNameForProgress) {
      const savedProgress = localStorage.getItem(`progress_${currentFileNameForProgress}`);
      if (savedProgress && videoRef) {
         videoRef.currentTime = parseFloat(savedProgress);
      }
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

  function promptClearCache() {
    f7.dialog.confirm(
      `This will delete all saved processed videos and free up ${storageUsed}. You will need to process them again next time.`,
      "Clear Local Cache?",
      async () => {
        await clearCache();
      }
    );
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

  async function handleFile(file: File) {
    if (!file) return;
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
        console.error('WORKERFS mount failed. Fallback disabled for testing.', e);
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
        await ffmpeg.exec(['-i', inputPath, '-vframes', '1', '-f', 'null', '-']);
      } catch (e) {}
      ffmpeg.off('log', logHandler);

      let extractedTracks: SubtitleTrack[] = [];
      let finalVideoUrl: string = '';

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
            // Execute once to extract all subtitle tracks simultaneously
            const subRet = await ffmpeg.exec(extractArgs);
            if (subRet === 0) {
               for (let i = 0; i < subtitleStreams.length; i++) {
                  const sub = subtitleStreams[i];
                  const outName = outNames[i];
                  const subData = await ffmpeg.readFile(outName);
                  const subBlob = new Blob([subData as Uint8Array], { type: 'text/vtt' });
                  extractedTracks.push({
                     url: URL.createObjectURL(subBlob),
                     label: `Track ${sub.index + 1} (${sub.language})`,
                     language: sub.language
                  });
                  await ffmpeg.deleteFile(outName);
               }
            }
         } catch(e) {
            console.error(`Subtitle extraction failed`, e);
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

        statusMessage = 'Releasing input file memory...';
        if (mounted) {
          try { await ffmpeg.unmount(mountDir); } catch(e) {}
          try { await ffmpeg.deleteDir(mountDir); } catch(e) {}
        }
        mounted = false; // Prevent double cleanup later

        statusMessage = 'Saving to local cache (clearing RAM)...';
        let data: Uint8Array | null = await ffmpeg.readFile(outputName) as Uint8Array;
        
        await ffmpeg.deleteFile('output.mp4');
        const cacheVideoUrl = `/cache-media/${encodeURIComponent(file.name)}/video.mp4`;

        const blob = new Blob([data], { type: 'video/mp4' });

        if (window.caches) {
           const cache = await caches.open('local-player-media');
           await cache.put(cacheVideoUrl, new Response(blob, { headers: { 'Content-Type': 'video/mp4' } })); 
        }
        finalVideoUrl = URL.createObjectURL(blob);
        
        // Immediately release the massive JS memory buffer to help GC
        data = null;
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
        ['output.mp4'].forEach(async file => {
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

<App {...f7params}>
  <View main>
    <Page>
      <Navbar>
        <NavLeft>
          {#if view === 'play' && appState === 'PLAYING'}
            <Link iconF7="arrow_left" onClick={goBack} />
          {/if}
        </NavLeft>
        <NavTitle>Local Player</NavTitle>
        <NavRight>
          {#if view === 'play' && appState === 'PLAYING'}
            <div class="flex items-center pr-2">
              {#if isProcessingSubtitle}
                <Preloader size={24} />
              {:else}
                <input 
                  type="file" 
                  accept=".srt,.ass" 
                  bind:this={subtitleInputRef} 
                  onchange={handleSubtitleChange} 
                  class="hidden" 
                />
                <Link iconF7="captions_bubble" onClick={() => subtitleInputRef?.click()} />
              {/if}
            </div>
          {/if}
        </NavRight>
      </Navbar>

      <div class="page-content bg-white dark:bg-[#121212] p-4 flex flex-col">
        {#if view === 'home'}
          <!-- 调整了 justify-start 并添加 pt-12 (顶部 padding) 来整体抬高位置 -->
          <div class="w-full max-w-2xl mx-auto flex flex-col items-center justify-start pt-12 flex-1 min-h-[calc(100vh-120px)]">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="w-full cursor-pointer shadow-lg card mb-8" ondragover={handleDragOver} ondrop={handleDrop} onclick={() => fileInputRef?.click()}>
              <div class="card-content flex flex-col items-center py-12 px-4">
                <Icon f7="cloud_upload_fill" size="64px" color="blue" />
                <h2 class="mt-4 mb-2 text-2xl font-semibold text-center">Drag & drop your video here</h2>
                <p class="text-center text-gray-500 mb-6">
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
                <Button fill round>Browse Files</Button>
              </div>
            </div>

            {#if storageUsed !== ''}
              <div class="flex items-center justify-between w-full px-6 py-4 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1A1A1A]">
                 <div class="flex flex-col">
                     <span class="text-sm font-medium text-gray-800 dark:text-gray-200">Local Storage Used</span>
                     <span class="text-xs text-gray-500 dark:text-gray-400">{storageUsed}</span>
                 </div>
                 <Button tonal round onClick={promptClearCache}>Clear Cache</Button>
              </div>
            {/if}
          </div>
        {/if}

        {#if view === 'play'}
          <div class="w-full flex-1 flex flex-col items-center justify-center">
            {#if appState === 'CONVERTING'}
                <div class="w-full max-w-md p-8 flex flex-col items-center text-center">
                   <div class="mb-8"><Preloader size={64} /></div>
                   <h3 class="text-xl font-semibold mb-2">Processing Video</h3>
                   <p class="text-gray-500 dark:text-gray-400 mb-6 min-h-[48px]">{statusMessage}</p>
                   
                   <div class="w-full">
                     <div class="flex mb-2 items-center justify-between">
                       <span class="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                         {progress}%
                       </span>
                     </div>
                     <Progressbar progress={progress} />
                   </div>
                </div>
              {/if}

              {#if appState === 'ERROR'}
                 <div class="text-center p-8">
                    <div class="mb-4"><Icon f7="exclamationmark_triangle" size="64px" color="red" /></div>
                    <h3 class="text-xl font-semibold mb-2 text-red-600 dark:text-red-400">Processing Failed</h3>
                    <p class="text-gray-600 dark:text-gray-300 mb-6 max-w-md">{errorMessage}</p>
                    <Button fill round onClick={goBack}>Go Back</Button>
                 </div>
              {/if}

              {#if appState === 'PLAYING'}
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                  bind:this={videoRef}
                  src={videoUrl}
                  controls
                  playsinline
                  class="max-w-[90vw] max-h-[80vh] bg-black rounded-lg shadow-xl"
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
                   <Icon f7="info_circle" size="16px" />
                   <span>Playing locally directly from browser.</span>
                </div>
              {/if}
            </div>
          {/if}
      </div>
    </Page>
  </View>
</App>
