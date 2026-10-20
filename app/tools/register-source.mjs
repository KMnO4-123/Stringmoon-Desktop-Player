// Run application modules in node:test using the project's TypeScript compiler.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

registerHooks({
  resolve(specifier, context, nextResolve) {
    let url
    if (specifier.startsWith('@shared/')) {
      url = new URL('../src/shared/' + specifier.slice(8), import.meta.url)
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      url = new URL(specifier, context.parentURL)
    }
    if (url) {
      for (const suffix of ['', '.ts', '.tsx']) {
        const candidate = new URL(url.href + suffix)
        if (/\.tsx?$/.test(candidate.pathname) && existsSync(candidate)) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\.tsx?$/.test(new URL(url).pathname)) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
      })
      return { format: 'module', source: outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  }
})
