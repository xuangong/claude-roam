#!/usr/bin/env node
// Build script to create a single-file preview.html with inlined JS and CSS

import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliAssetsDir = join(__dirname, '..', 'cli', 'assets')

// Build preview as a single file
await build({
  configFile: false,
  root: __dirname,
  plugins: [
    react(),
    viteSingleFile()
  ],
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    rollupOptions: {
      input: 'preview.html',
    },
  },
  logLevel: 'warn',
})

// Copy to cli/assets
mkdirSync(cliAssetsDir, { recursive: true })
const previewHtml = readFileSync(join(__dirname, 'dist-preview', 'preview.html'), 'utf-8')
writeFileSync(join(cliAssetsDir, 'preview.html'), previewHtml)

console.log('Built single-file preview.html to cli/assets/')
console.log(`Size: ${(previewHtml.length / 1024).toFixed(1)} KB`)
