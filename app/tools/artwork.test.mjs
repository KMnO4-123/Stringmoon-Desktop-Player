import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// 与 frequency-native.test.mjs 同一个坑：Windows 上 electron.exe 可能被 Defender /
// 索引服务短暂占用，两个测试文件并行 spawn 时会直接 EBUSY。只对启动竞争重试，
// 用例本身的断言失败必须立刻冒泡。
async function runElectron(script, options) {
  const delays = [0, 250, 750, 1500]
  let lastError
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      return await promisify(execFile)(require('electron'), [script], options)
    } catch (error) {
      lastError = error
      if (error?.code !== 'EBUSY' && !/EBUSY/.test(String(error?.message))) throw error
    }
  }
  throw lastError
}
test('native artwork decoding rejects corrupt images, reads embedded covers and persists valid local selections', { timeout: 30000 }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'twilight-artwork-'))
  const tools = fileURLToPath(new URL('../.smoke/artwork-test/', import.meta.url))
  await mkdir(tools, { recursive: true })
  const source = await readFile(new URL('../src/main/artwork.ts', import.meta.url), 'utf8')
  await writeFile(path.join(tools, 'reader.cjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)
  await writeFile(path.join(tools, 'runner.cjs'), `
const { app, nativeImage } = require('electron');
// 测试不需要 GPU：CI runner 没有显卡，GPU 进程启动失败会连带渲染进程崩溃。
// 关掉硬件加速让 Chromium 走软件路径，本地与 CI 行为一致。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const {readArtwork, setArtwork, configureArtwork} = require('./reader.cjs');
const folder = ${JSON.stringify(folder)};
app.setPath('userData', path.join(folder, 'profile'));
app.whenReady().then(async () => {
  try {
    const audio = path.join(folder, 'track.flac'), selected = path.join(folder, 'chosen.png'), config = path.join(folder, 'artwork.json');
    await fs.writeFile(audio, 'invalid metadata with a valid sidecar');
    const png = nativeImage.createFromBuffer(Buffer.from([30, 90, 180, 255]), {width:1,height:1}).toPNG();
    await fs.writeFile(path.join(folder, 'track.png'), png);
    await fs.writeFile(selected, png);
    configureArtwork(config);
    assert.equal((await readArtwork(audio)).source, 'sidecar');
    assert.equal(await readArtwork(selected), null);
    assert.equal(await readArtwork(path.join(folder, 'missing.flac')), null);
    const broken = path.join(folder, 'broken.png');
    await fs.writeFile(broken, Buffer.from([137,80,78,71]));
    assert.equal(await setArtwork(audio, broken), null);
    assert.equal((await readArtwork(audio)).source, 'sidecar');
    assert.equal((await setArtwork(audio, selected)).source, 'custom');
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8'))[audio], selected);
    assert.equal(await setArtwork(audio, broken), null);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8'))[audio], selected);
    await fs.writeFile(selected, Buffer.from([137,80,78,71]));
    await fs.writeFile(audio, 'changed audio stamp');
    assert.equal((await readArtwork(audio)).source, 'sidecar');
    const uint = n => {const b=Buffer.alloc(4);b.writeUInt32BE(n);return b};
    const info = Buffer.alloc(34); info.writeUInt16BE(4096,0); info.writeUInt16BE(4096,2); info.writeUInt32BE((44100<<12)|(1<<9)|(15<<4),10);info.writeUInt32BE(44100,14);
    const mime = Buffer.from('image/png');
    const picture = Buffer.concat([uint(3),uint(mime.length),mime,uint(0),uint(1),uint(1),uint(32),uint(0),uint(png.length),png]);
    const header=Buffer.alloc(4);header[0]=134;header.writeUIntBE(picture.length,1,3);
    const embedded=path.join(folder,'embedded.flac');
    await fs.writeFile(embedded, Buffer.concat([Buffer.from('fLaC'),Buffer.from([0,0,0,34]),info,header,picture]));
    assert.equal((await readArtwork(embedded)).source, 'embedded');
    console.log('ARTWORK_NATIVE_OK'); app.exit(0);
  } catch(error) {console.error(error);app.exit(1)}
});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  try {
    const { stdout } = await runElectron(path.join(tools, 'runner.cjs'), { env, windowsHide: true, timeout: 25000 })
    assert.ok(stdout.includes('ARTWORK_NATIVE_OK'))
  } finally {
    const target = path.resolve(folder)
    assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(target).startsWith('twilight-artwork-'))
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
