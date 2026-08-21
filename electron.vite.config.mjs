import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The policy is injected here rather than written into index.html because dev
// needs one extra allowance: @vitejs/plugin-react injects its fast-refresh
// preamble as an *inline* module script, which a script-src of 'self' alone
// blocks — and without the preamble the renderer throws before it draws
// anything. The built app gets the strict version.
function csp(isDev) {
  const policy = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    isDev ? 'connect-src *' : "connect-src 'self'"
  ].join('; ')

  return {
    name: 'csp-meta',
    transformIndexHtml(html) {
      // First thing in <head>: a policy only governs what the parser sees
      // after it, and vite's own script tag is injected before </head>.
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy};" />`
      )
    }
  }
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.js')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.js')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: {
          // CodeMirror's language-data loads each grammar with a dynamic
          // import. Split into chunks those become file:// fetches at runtime,
          // and a failed one degrades silently to no syntax highlighting;
          // inlining them trades a bigger bundle for a build that either works
          // or doesn't.
          inlineDynamicImports: true
        }
      },
      // The grammars alone are around a megabyte. That's fine for a local app,
      // and the warning is just noise.
      chunkSizeWarningLimit: 4096
    },
    plugins: [react(), csp(mode === 'development')]
  }
}))
