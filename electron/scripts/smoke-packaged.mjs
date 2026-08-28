import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedSmokeArchitecture } from './architecture.mjs'
import { verifyPackagedApplication } from './verify-package.mjs'

const architecture = resolvePackagedSmokeArchitecture(process.argv[2])
const rendererLab = process.env.RASTERFORM_RENDERER_LAB === '1'
const applicationName = rendererLab ? 'Rasterform Renderer Lab' : 'Rasterform'
const bundleId = rendererLab ? 'io.atil.rasterform.rendererlab' : 'io.atil.rasterform'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const applicationPath = join(
  electronRoot,
  rendererLab ? 'out-lab' : 'out',
  `${applicationName}-darwin-${architecture}`,
  `${applicationName}.app`,
)
const executablePath = join(applicationPath, 'Contents', 'MacOS', applicationName)

const verification = await verifyPackagedApplication(applicationPath, architecture, {
  executableName: applicationName,
  bundleId,
})
console.log(`RASTERFORM_PACKAGE_VERIFIED ${JSON.stringify(verification)}`)

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [join(scriptsDirectory, 'smoke.mjs'), executablePath], {
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', (code) => resolveExit(code))
})
if (exitCode !== 0) process.exitCode = exitCode ?? 1
