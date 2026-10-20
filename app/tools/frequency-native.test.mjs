import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

// Windows 上 electron.exe 会被 Defender / 索引服务短暂占用，两个测试文件并行时
// spawn 可能直接 EBUSY（首次 CI 就撞上了）。这不是断言失败，而是启动竞争：
// 短暂退避后重试即可，不要让一次文件锁竞争把整个套件判红。
async function runElectron(script, options) {
  const delays = [0, 250, 750, 1500]
  let lastError
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      return await execFileAsync(require('electron'), [script], options)
    } catch (error) {
      lastError = error
      // 只有 spawn 层面的失败才重试；用例本身抛错要立刻冒泡，不能被重试掩盖。
      if (error?.code !== 'EBUSY' && !/EBUSY/.test(String(error?.message))) throw error
    }
  }
  throw lastError
}

// This exercises Chromium's actual Web Audio implementation in a hidden window.
// No engine process, device output, mocked Biquad or audible AudioContext is used.
test('native peaking response honors center gain, Q, headroom and the Nyquist bypass', { timeout: 30000 }, async () => {
  const source = await readFile(new URL('../src/renderer/src/audio/frequencyResponse.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
  const evaluate = `async () => {
    const { calculateResponse } = await import(${JSON.stringify(moduleUrl)});
    const original = globalThis.AudioContext;
    globalThis.AudioContext = class { constructor() { throw new Error('Audible context is forbidden'); } };
    const frequencies = [31.25,62.5,125,250,500,1000,2000,4000,8000,16000];
    const settings = (q, gain = 6, applied = 0, band = 1000) => ({
      eq: { enabled: true, q, preampDb: 0, autoHeadroom: applied < 0,
        bands: frequencies.map(freq => ({freq, gainDb: freq === band ? gain : 0})) },
      appliedGainDb: applied, passthrough: false, streaming: false
    });
    try {
      const center = calculateResponse(settings(1.41), 48000, [1000]).points[0].db;
      const headroom = calculateResponse(settings(1.41, 6, -6), 48000, [1000]).points[0].db;
      const broad = calculateResponse(settings(0.5), 48000, [500]).points[0].db;
      const narrow = calculateResponse(settings(4), 48000, [500]).points[0].db;
      const lowRate = calculateResponse(settings(1.41, 12, 0, 16000), 22050);
      const zero = calculateResponse(settings(1.41, 0), 48000);
      return { center, headroom, broad, narrow, lowRateMaximum: lowRate.maxHz,
        lowRateFlat: lowRate.points.every(p => Math.abs(p.db) < 0.0001),
        zeroFlat: zero.points.every(p => Math.abs(p.db) < 0.0001) };
    } finally { globalThis.AudioContext = original; }
  }`
  const directory = await mkdtemp(path.join(tmpdir(), 'twilight-frequency-'))
  const script = path.join(directory, 'native.cjs')
  await writeFile(script, `const { app, BrowserWindow } = require('electron');
// 同 artwork.test.mjs：无 GPU 环境下必须关掉硬件加速，否则 GPU 进程启动失败会拖垮渲染进程。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false, webPreferences:{contextIsolation:true,sandbox:true}});
  try {
    await win.loadURL('about:blank');
    const data = await win.webContents.executeJavaScript(${JSON.stringify('(' + evaluate + ')()')});
    console.log('NATIVE_RESPONSE_RESULT:' + JSON.stringify(data));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const { stdout } = await runElectron(script, { env, windowsHide: true, timeout: 20000 })
    const line = stdout.split(/\r?\n/).find(line => line.startsWith('NATIVE_RESPONSE_RESULT:'))
    assert.ok(line, 'hidden Chromium test returned its measurements')
    const values = JSON.parse(line.slice('NATIVE_RESPONSE_RESULT:'.length))
    assert.ok(Math.abs(values.center - 6) < 0.002, `1k center must be +6dB; got ${values.center}`)
    assert.ok(Math.abs(values.headroom) < 0.002, 'engine -6dB headroom cancels the +6dB center boost')
    assert.ok(values.broad > values.narrow + 1, 'a larger Q narrows the actual filter response')
    assert.equal(values.lowRateMaximum, 11025)
    assert.equal(values.lowRateFlat, true, '16k band is identity at a 22.05k sample rate, as in dsp.cpp')
    assert.equal(values.zeroFlat, true)
  } finally {
    const resolved = path.resolve(directory)
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('twilight-frequency-'))
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
