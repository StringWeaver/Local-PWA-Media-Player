import React, { useState, useRef, useEffect, DragEvent, ChangeEvent } from 'react';
import { UploadCloud, FileVideo, ArrowLeft, Loader2, AlertCircle, Plus } from 'lucide-react';
import { getFfmpeg } from './lib/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

type AppState = 'IDLE' | 'CONVERTING' | 'PLAYING' | 'ERROR';

type SubtitleTrack = { url: string; label: string; language: string };

export default function App() {
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [isProcessingSubtitle, setIsProcessingSubtitle] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSaveRef = useRef<number>(0);

  // Auto clean up blob urls to prevent memory leaks
  useEffect(() => {
    return () => {
      if (videoUrl && appState !== 'PLAYING') {
        URL.revokeObjectURL(videoUrl);
      }
      if (appState !== 'PLAYING') {
        subtitleTracks.forEach(t => URL.revokeObjectURL(t.url));
      }
    };
  }, [videoUrl, subtitleTracks, appState]);

  const handleFile = async (file: File) => {
    if (!file) return;
    
    // Check if browser natively supports the file
    // .mp4, .webm, .m4v are usually supported directly
    const isMkv = file.name.toLowerCase().endsWith('.mkv');
    
    await processFile(file, isMkv);
  };

  const processFile = async (file: File, isMkv: boolean) => {
    setCurrentFile(file);
    setAppState('CONVERTING');
    setProgress(0);
    setStatusMessage('Loading FFmpeg core...');

    try {
      const ffmpeg = await getFfmpeg();

      // Clean up previous listeners
      ffmpeg.off('log', () => {});
      ffmpeg.off('progress', () => {});

      setStatusMessage('Reading file into memory...');
      await ffmpeg.writeFile('input_media', await fetchFile(file));

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
        await ffmpeg.exec(['-i', 'input_media', '-c:v', 'copy', '-f', 'null', '-']);
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
             const subRet = await ffmpeg.exec(['-i', 'input_media', '-map', `0:s:${sub.index}`, outName]);
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

      if (isMkv) {
        setStatusMessage('Remuxing MKV to MP4 format...');
        ffmpeg.on('progress', ({ progress: p }) => {
          // Make sure progress is clamped between 0 and 1
          const percent = Math.max(0, Math.min(100, Math.round(p * 100)));
          setProgress(percent);
        });

        const outputName = 'output.mp4';
        const command = [
          '-i', 'input_media',
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

        setStatusMessage('Preparing playback...');
        const data = await ffmpeg.readFile(outputName);
        
        await ffmpeg.deleteFile('output.mp4');

        const blob = new Blob([data], { type: 'video/mp4' });
        finalVideoUrl = URL.createObjectURL(blob);
      } else {
        finalVideoUrl = URL.createObjectURL(file);
      }
      
      // Cleanup WASM memory
      await ffmpeg.deleteFile('input_media');

      setVideoUrl(finalVideoUrl);
      if (extractedTracks.length > 0) {
        setSubtitleTracks(extractedTracks);
      }
      setAppState('PLAYING');

    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'An error occurred during video processing.');
      setAppState('ERROR');
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
       alert('Only .srt and .ass subtitles are supported.');
       return;
    }
    
    setIsProcessingSubtitle(true);
    try {
       const ffmpeg = await getFfmpeg();
       const inputName = `ext_${file.name.replace(/\s+/g, '_')}`;
       const outputName = `ext_${Date.now()}.vtt`;
       
       await ffmpeg.writeFile(inputName, await fetchFile(file));
       const ret = await ffmpeg.exec(['-i', inputName, outputName]);
       
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
           alert('Failed to process external subtitle.');
       }
       await ffmpeg.deleteFile(inputName);
    } catch(err) {
       console.error("External subtitle processing failed", err);
       alert('Error processing subtitle file.');
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
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#121212] text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
      
      {/* App Bar (Hidden in PLAYING state if we want full immersion, but let's keep it simple) */}
      <header className="px-6 py-4 flex items-center justify-center border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-[#1A1A1A]/80 backdrop-blur-md sticky top-0 z-10 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <FileVideo className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          Local Player
        </h1>
      </header>

      <main className="max-w-screen-lg mx-auto p-6 flex flex-col items-center justify-center" style={{ minHeight: 'calc(100vh - 70px)' }}>
        
        {appState === 'IDLE' && (
          <div className="w-full max-w-2xl">
            <div 
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center justify-center px-8 py-20 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-3xl cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 transition duration-200 group bg-white dark:bg-[#1A1A1A] shadow-sm"
            >
              <div className="w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                <UploadCloud className="w-8 h-8 text-indigo-600 dark:text-indigo-400" />
              </div>
              <h2 className="text-xl font-medium mb-2 text-center">Drag & drop your video here</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm">
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
              <button className="mt-8 px-6 py-2.5 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-medium hover:opacity-90 transition-opacity focus:outline-none focus:ring-4 focus:ring-gray-200 dark:focus:ring-gray-700">
                Browse Files
              </button>
            </div>
          </div>
        )}

        {appState === 'CONVERTING' && (
          <div className="flex flex-col items-center justify-center w-full max-w-md bg-white dark:bg-[#1A1A1A] p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800">
            <div className="relative mb-8">
               <Loader2 className="w-14 h-14 text-indigo-500 animate-spin" />
               <div className="absolute inset-0 flex items-center justify-center">
                 <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">{progress}%</span>
               </div>
            </div>
            <h2 className="text-lg font-medium mb-2">Processing MKV File</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-6">
              {statusMessage || 'Preparing...'}
            </p>
            <div className="w-full h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
               <div 
                 className="h-full bg-indigo-500 transition-all duration-300 rounded-full"
                 style={{ width: `${progress}%` }}
               />
            </div>
          </div>
        )}

        {appState === 'ERROR' && (
          <div className="flex flex-col items-center justify-center w-full max-w-md bg-white dark:bg-[#1A1A1A] p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800">
            <div className="w-16 h-16 rounded-full bg-red-50 dark:bg-red-900/30 flex items-center justify-center mb-6">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-medium mb-2">Error Processing Video</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-8">
              {errorMessage}
            </p>
            <button 
              onClick={goBack}
              className="px-6 py-2 rounded-full border border-gray-300 dark:border-gray-700 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Go Back
            </button>
          </div>
        )}

        {appState === 'PLAYING' && videoUrl && (
          <div className="w-full flex-1 flex flex-col w-full max-w-5xl">
            <div className="flex items-center justify-between mb-4">
              <button 
                onClick={goBack} 
                className="flex items-center gap-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors bg-white dark:bg-[#1A1A1A] px-4 py-2 rounded-full shadow-sm"
              >
                <ArrowLeft className="w-4 h-4" />
                Close Video
              </button>
              
              <div className="flex items-center gap-4">
                {isProcessingSubtitle ? (
                    <span className="text-sm font-medium text-indigo-500 dark:text-indigo-400 flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin"/> Converting...
                    </span>
                ) : (
                    <>
                        <input type="file" accept=".srt,.ass" ref={subtitleInputRef} onChange={handleSubtitleChange} className="hidden" />
                        <button 
                          onClick={() => subtitleInputRef.current?.click()} 
                          className="flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:opacity-80 transition-opacity bg-white dark:bg-[#1A1A1A] px-4 py-2 rounded-full shadow-sm border border-indigo-100 dark:border-indigo-900/30"
                        >
                            <Plus className="w-4 h-4" />
                            Add Subtitle
                        </button>
                    </>
                )}
                {currentFile && (
                  <span className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate max-w-[200px] sm:max-w-sm">
                    {currentFile.name}
                  </span>
                )}
              </div>
            </div>
            
            <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-gray-200 dark:border-gray-800">
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

      </main>
    </div>
  );
}
