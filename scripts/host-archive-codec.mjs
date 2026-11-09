// Build-time codec only. Python is already required by template validation; no
// runtime dependency or downloaded executable is embedded in the host archive.
import { execFileSync } from "node:child_process";

// The package is an immutable image asset. The Downward API carries only its
// digest and public configuration, with its own smaller annotation bound.
export const HOST_IMAGE_ARCHIVE_MAX_BYTES = 256 * 1024;

const code = `import lzma,sys
raw=sys.stdin.buffer.read(2*1024*1024+1)
if sys.argv[1]=='encode':
    if len(raw)>2*1024*1024: raise ValueError('archive expansion bound')
    result=lzma.compress(raw,format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC64,filters=[{'id':lzma.FILTER_X86},{'id':lzma.FILTER_LZMA2,'preset':6|lzma.PRESET_EXTREME,'pb':0,'mf':lzma.MF_BT3}])
else:
    if len(raw)>${HOST_IMAGE_ARCHIVE_MAX_BYTES}: raise ValueError('archive compressed bound')
    stream=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=32*1024*1024)
    result=stream.decompress(raw,max_length=2*1024*1024+1)
    if len(result)>2*1024*1024 or not stream.eof or stream.unused_data: raise ValueError('archive stream bound')
sys.stdout.buffer.write(result)
`;
function codec(operation, bytes) {
  return execFileSync("python3", ["-I", "-B", "-c", code, operation], {
    input: bytes,
    maxBuffer: 2 * 1024 * 1024 + 1024,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
export const encodeHostArchive = (bytes) => codec("encode", bytes);
export const decodeHostArchive = (bytes) => codec("decode", bytes);
