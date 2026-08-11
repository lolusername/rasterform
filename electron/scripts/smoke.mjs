import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronExecutable from 'electron'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const executable = process.argv[2] ? resolve(process.argv[2]) : electronExecutable
const args = process.argv[2] ? [] : [join(electronRoot, '.stage')]
await access(executable)

const childEnvironment = {
  ...process.env,
  RASTERFORM_DESKTOP_SMOKE: '1',
  ELECTRON_ENABLE_LOGGING: '1',
}
// Keep the staged smoke deterministic too. Packaged builds additionally ignore
// these knobs because the corresponding Electron fuses are disabled.
delete childEnvironment.ELECTRON_RUN_AS_NODE
delete childEnvironment.NODE_OPTIONS
delete childEnvironment.NODE_EXTRA_CA_CERTS

const child = spawn(executable, args, {
  env: childEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
})

// A cold packaged Electron launch can take longer on CI. Keep this test-only
// guard generous, but always escalate to a hard stop so a failed smoke can
// never hang CI. Cross-architecture Rosetta launches are rejected upstream.
const SMOKE_TIMEOUT_MS = 90_000
const FORCE_KILL_GRACE_MS = 2_000

let output = ''
let marker = ''
const capture = (chunk) => {
  const text = chunk.toString()
  output += text
  process.stdout.write(text)
  const match = text.match(/RASTERFORM_DESKTOP_SMOKE (\{[^\n]+\})/)
  if (match) marker = match[1]
}
child.stdout.on('data', capture)
child.stderr.on('data', capture)

let timedOut = false
let forceKillTimer = null
const timeout = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_GRACE_MS)
}, SMOKE_TIMEOUT_MS)

const exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
clearTimeout(timeout)
if (forceKillTimer) clearTimeout(forceKillTimer)
if (!marker) {
  const timeoutDetail = timedOut ? ` within ${SMOKE_TIMEOUT_MS / 1_000} seconds` : ''
  throw new Error(`Rasterform did not emit a smoke result${timeoutDetail}.\n${output.slice(-4_000)}`)
}
const result = JSON.parse(marker)
if (!result.passed || exitCode !== 0) {
  throw new Error(`Rasterform desktop smoke failed (${exitCode}): ${JSON.stringify(result)}`)
}
console.log('Rasterform desktop runtime smoke passed.')
