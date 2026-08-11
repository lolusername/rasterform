import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedSmokeArchitecture } from './architecture.mjs'
import { verifyPackagedApplication } from './verify-package.mjs'

const architecture = resolvePackagedSmokeArchitecture(process.argv[2])

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const applicationPath = join(
  electronRoot,
  'out',
  `Rasterform-darwin-${architecture}`,
  'Rasterform.app',
)
const executablePath = join(applicationPath, 'Contents', 'MacOS', 'Rasterform')

const verification = await verifyPackagedApplication(applicationPath, architecture)
console.log(`RASTERFORM_PACKAGE_VERIFIED ${JSON.stringify(verification)}`)

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [join(scriptsDirectory, 'smoke.mjs'), executablePath], {
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', (code) => resolveExit(code))
})
if (exitCode !== 0) process.exitCode = exitCode ?? 1
