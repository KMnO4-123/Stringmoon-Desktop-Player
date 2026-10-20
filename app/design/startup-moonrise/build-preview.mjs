// Design-only, self-contained motion preview. Not part of application startup.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('./', import.meta.url)
const screenshot = readFileSync(new URL('app-screen.png', root)).toString('base64')
const template = readFileSync(new URL('preview.template.html', root), 'utf8')
writeFileSync(new URL('preview.html', root), template.replace('APP_SCREENSHOT_BASE64', screenshot))
const moon = template.match(/<svg class="moon"[\s\S]*?<\/svg>/)[0].replace('class="moon"','x="0" y="0" width="1024" height="1024"')
const girl = template.match(/<svg class="girl"[\s\S]*?<\/svg>/)[0].replace('class="girl"','x="0" y="0" width="1024" height="1024"')
writeFileSync(new URL('brand-mark.svg', root), `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${moon}${girl}</svg>`)
console.log(fileURLToPath(new URL('preview.html', root)))
