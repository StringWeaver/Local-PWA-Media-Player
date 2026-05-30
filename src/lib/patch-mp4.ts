/**
 * Patches the tkhd (track header) boxes in an MP4 file to fix playback issues on Apple devices (macOS QuickTime, iOS Safari).
 * 
 * Some remuxers (like mediabunny when remuxing from an MKV file missing default dispositions) might output
 * track headers with the "enabled" flag unset (0x02 instead of 0x03). QuickTime and Safari are strict and
 * will refuse to play these files.
 * 
 * This function streams the file using OPFS to find 'tkhd' magic bytes and overwrites the flag byte in-place
 * with a minimal memory footprint.
 */
export async function patchAppleTkhd(fileHandle: FileSystemFileHandle) {
  const patchFile = await fileHandle.getFile();
  const stream = patchFile.stream();
  const reader = stream.getReader();
  const tkhdMagic = new Uint8Array([0x74, 0x6b, 0x68, 0x64]); // 'tkhd'
  
  let offset = 0;
  let buffer = new Uint8Array(0);
  const offsetsToPatch: number[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    if (value) {
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      for (let i = 0; i <= buffer.length - 4; i++) {
        if (
          buffer[i] === tkhdMagic[0] &&
          buffer[i+1] === tkhdMagic[1] &&
          buffer[i+2] === tkhdMagic[2] &&
          buffer[i+3] === tkhdMagic[3]
        ) {
          offsetsToPatch.push(offset + i);
        }
      }

      if (buffer.length > 3) {
        offset += buffer.length - 3;
        buffer = buffer.slice(buffer.length - 3);
      } else {
        offset += buffer.length;
        buffer = new Uint8Array(0);
      }
    }
  }

  if (offsetsToPatch.length > 0) {
    const writablePatch = await fileHandle.createWritable({ keepExistingData: true });
    for (const patchOffset of offsetsToPatch) {
      await writablePatch.seek(patchOffset + 7);
      await writablePatch.write(new Uint8Array([3]));
    }
    await writablePatch.close();
    console.log(`Patched ${offsetsToPatch.length} tkhd boxes for QuickTime compatibility.`);
  }
}
