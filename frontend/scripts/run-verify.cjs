/* 仅用于在 Node 里跑 scripts/verify-completion.ts：即时转译 TS 并解析 @/ 别名，不参与生产构建。 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    request = path.join(root, 'src', request.slice(2))
  }
  return originalResolve.call(this, request, parent, isMain, options)
}

Module._extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

require('./verify-completion.ts')
