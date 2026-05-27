<script lang="ts">
  import { fly } from 'svelte/transition';
  import { getFfmpeg } from './lib/ffmpeg';
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

  $effect(() => {
    if (appState === 'IDLE') {
      updateStorageEstimate();
    }
  });

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
    if (appState === 'PLAYING' && videoRef && currentFileNameForProgress) {
      const savedProgress = localStorage.getItem(`progress_${currentFileNameForProgress}`);
      
      const handlePlay = () => {
        if (savedProgress && videoRef && !videoRef.dataset.progressRestored) {
          videoRef.currentTime = parseFloat(savedProgress);
          videoRef.dataset.progressRestored = "true";
        }
      };
      
      videoRef.addEventListener('play', handlePlay);

      playbackTimer = setInterval(() => {
         if (videoRef && !videoRef.paused) {
             localStorage.setItem(`progress_${currentFileNameForProgress}`, videoRef.currentTime.toString());
         }
      }, 2000);
      
      return () => {
        if (videoRef) {
          videoRef.removeEventListener('play', handlePlay);
          videoRef.removeAttribute('data-progress-restored');
        }
        if (playbackTimer) {
          clearInterval(playbackTimer);
          playbackTimer = undefined;
        }
      };
    }
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
    if (!file) return;
    const isMkv = file.name.toLowerCase().endsWith('.mkv');
    view = 'play';
    await processFile(file, isMkv);
  }

  async function processFile(file: File, isMkv: boolean) {
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
        await ffmpeg.exec(['-i', inputPath, '-vframes', '1', '-f', 'null', '-']);
      } catch (e) {}
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
          video: async (videoTrack) => {
             // Not setting `codec` forces a stream copy without transcoding
             const trackConfig: any = {};
             if (isHevc) {
                // In MediaBunny, the valid codec identifier is 'hevc'
                trackConfig.codec = 'hevc';
             }
             return trackConfig;
          },
          audio: async (audioTrack) => {
             return {};
          }
        });

        conversion.onProgress = (p) => {
          progress = Math.max(0, Math.min(100, Math.round(p * 100)));
        };

        await conversion.execute();

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
