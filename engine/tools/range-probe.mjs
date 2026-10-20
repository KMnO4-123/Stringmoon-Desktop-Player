import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const file = process.argv[2]
if (!file) throw new Error('usage: node range-probe.mjs <file>')
const mode = process.argv[3] === 'decode' ? '--probe-decode' : '--probe-io'
const size = statSync(file).size
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range ?? '')
  if (!range) {
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    createReadStream(file).pipe(res)
    return
  }
  const start = Number(range[1])
  const end = range[2] ? Number(range[2]) : size - 1
  if (start >= size || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }
  const actualEnd = Math.min(end, size - 1)
  res.writeHead(206, {
    'Content-Length': actualEnd - start + 1,
    'Content-Range': `bytes ${start}-${actualEnd}/${size}`,
    'Accept-Ranges': 'bytes'
  })
  createReadStream(file, { start, end: actualEnd }).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const child = spawn('<仓库根>/engine/bin/twilight-engine.exe', [
  mode, `http://127.0.0.1:${port}/audio.flac`
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })
const code = await new Promise(resolve => child.on('close', resolve))
server.close()
process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)
process.exitCode = code
