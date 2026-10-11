import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const corePackageJson = JSON.parse(readFileSync('../core/package.json', 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    UnoCSS() as any,
    viteCompression({
      verbose: true,
      disable: false,
      threshold: 10240,
      algorithm: 'gzip',
      ext: '.gz',
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules'))
            return
          const norm = id.replace(/\\/g, '/')
          // naive-ui 及其依赖链单独成组。
          // 注意不能用 includes('vue') 这类模糊匹配：vueuc 名字含 vue 会被误分到
          // vendor-vue，把 naive-ui 的依赖劈成两半形成循环依赖，运行时报
          // "Cannot access 'isFunction' before initialization"。
          if (/node_modules\/(naive-ui|vueuc|seemly|css-render|@css-render|vdirs|vooks|treemate|evtd|date-fns|date-fns-tz|async-validator|highlight\.js|lodash|lodash-es|@juggle)\//.test(norm)) {
            return 'vendor-naive'
          }
          if (/node_modules\/(@vue|vue|pinia|vue-router|@vueuse)\//.test(norm)) {
            return 'vendor-vue'
          }
          if (/node_modules\/axios\//.test(norm)) {
            return 'vendor-axios'
          }
          // Split other large dependencies if needed
          if (/node_modules\/(echarts|zrender)\//.test(norm)) {
            return 'vendor-echarts'
          }
          // Default vendor chunk
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  define: {
    __APP_VERSION__: JSON.stringify(corePackageJson.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
      '/game-config': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
    },
  },
})
