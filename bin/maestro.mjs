#!/usr/bin/env node
/**
 * npx/CLI launcher for Maestro.
 *
 * Resolves the electron binary and boots the built app (out/ + package.json
 * `main`). When the package was installed without electron (it's a devDep so
 * electron-builder accepts it), falls back to running electron via npx, which
 * downloads it into the npx cache on first use — no admin rights needed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
  console.error('Maestro: built app not found (out/main/index.js missing). Run "npm run build" first.')
  process.exit(1)
}

const require = createRequire(import.meta.url)
let electronPath = null
try {
  // In plain Node, require('electron') resolves to the binary's path.
  const resolved = require('electron')
  if (typeof resolved === 'string') electronPath = resolved
} catch {
  // electron not installed alongside the package — use the npx fallback below
}

const child = electronPath
  ? spawn(electronPath, [appDir], { stdio: 'inherit' })
  : spawn('npx', ['-y', 'electron@^33.3.0', appDir], {
      stdio: 'inherit',
      shell: process.platform === 'win32' // npx is npx.cmd on Windows
    })

child.on('error', (err) => {
  console.error('Maestro: failed to launch electron:', err.message)
  process.exit(1)
})
child.on('close', (code) => process.exit(code ?? 0))
