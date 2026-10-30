// Build-time codec only. Python is already required by template validation; no
// runtime dependency or downloaded executable is embedded in the host archive.
import { execFileSync } from "node:child_process";

const code = `import lzma,sys
raw=sys.stdin.buffer.read(2*1024*1024+1)
if sys.argv[1]=='encode':
    if len(raw)>2*1024*1024: raise ValueError('archive expansion bound')
    result=lzma.compress(raw,format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC64,preset=6)
else:
    if len(raw)>160000: raise ValueError('archive compressed bound')
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
