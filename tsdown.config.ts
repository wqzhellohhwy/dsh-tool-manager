import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = "@dsh-external/dsh-tool-manager"

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

/**
 * host 半侧入口(ESM, node)。两个入口各自单独打一份 —— rolldown 在多入口下
 * 不允许关闭 code splitting，而我们要求产物是扁平的 lib/index.js 与
 * lib/preset-filter.js（后者必须能被包名子路径独立解析）。
 */
const hostIndexBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: '[name].js',
    codeSplitting: false,
  },
}

const hostFilterBundle: UserConfig = {
  entry: { 'preset-filter': 'src/preset-filter.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: '[name].js',
    codeSplitting: false,
  },
}

/**
 * 测试用入口:把判定纯逻辑打成 lib/decide.mjs,供 tests/decide.test.mjs
 * (node --test)直接 import —— 避免测试去解析 React 组件里未被导出的闭包函数。
 */
const decideBundle: UserConfig = {
  entry: { decide: 'src/client/decide.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: 'decide.mjs',
    codeSplitting: false,
  },
}

export default [clientBundle, hostIndexBundle, hostFilterBundle, decideBundle] satisfies UserConfig[]
