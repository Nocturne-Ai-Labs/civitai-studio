import { mkdir, readdir, readFile, copyFile, chmod, writeFile, unlink } from 'node:fs/promises'
import { resolve, join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dir, '..')
const version = '0.1.0-beta.1'
const args = process.argv.slice(2)
const requested = args.indexOf('--target')
const nativeTarget = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : 'x86_64-unknown-linux-gnu'
const target = requested < 0 ? nativeTarget : args[requested + 1]
const targets: Record<string, string> = {
  'x86_64-pc-windows-msvc': 'bun-windows-x64-baseline',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64-baseline',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
}
if (!targets[target]) throw new Error('Supported targets: ' + Object.keys(targets).join(', '))
const sidecarOnly = args.includes('--sidecar-only')
if (!sidecarOnly && !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported desktop build architecture')
if (!sidecarOnly && process.platform !== 'darwin' && process.arch !== 'x64') throw new Error('This beta supports ARM64 builds on macOS only')
if (!sidecarOnly && target !== nativeTarget) throw new Error('Build desktop releases on a native runner for the requested target. Use --sidecar-only for cross-platform server checks.')
const windows = target.includes('windows'), mac = target.includes('apple')
const generated = join(root, 'build', 'desktop'), binaries = join(root, 'desktop', 'src-tauri', 'binaries')
await mkdir(generated, { recursive: true }); await mkdir(binaries, { recursive: true })
const buildEnv = { ...process.env }
for (const name of Object.keys(buildEnv)) if (/^(CIVITAI_|STUDIO_|VITE_|NODE_OPTIONS$|BUN_OPTIONS$|BUN_PRELOAD$)/.test(name)) delete buildEnv[name]
buildEnv.STUDIO_RELEASE_BUILD = '1'

async function run(command: string[], cwd = root, env = buildEnv) {
  const child = Bun.spawn(command, { cwd, env, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  if (await child.exited !== 0) throw new Error('Build command failed: ' + command[0])
}
async function files(directory: string): Promise<string[]> {
  const children = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(children.map(child => child.isDirectory() ? files(join(directory, child.name)) : [join(directory, child.name)]))).flat()
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Vite gets no provider or application secrets; only the resulting static
// allowlist is embedded in the service, never a repository directory.
await run([process.execPath, '--no-env-file', 'run', '--cwd', 'web', 'build'])
const frontend = join(root, 'web', 'dist')
const assetFiles = (await files(frontend)).sort()
if (!assetFiles.some(file => relative(frontend, file).replaceAll('\\', '/') === 'index.html')) throw new Error('Frontend index missing')
const assetManifest: { path: string; sha256: string; bytes: number }[] = []
let imports = '', mapping: string[] = []
for (const [index, file] of assetFiles.entries()) {
  const path = '/' + relative(frontend, file).replaceAll('\\', '/')
  if (!/^\/(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css|svg|png|jpg|jpeg|webp|woff2?))$/.test(path)) throw new Error('Unexpected frontend release asset: ' + path)
  const bytes = await readFile(file)
  if (/CIVITAI_(?:DEVELOPMENT_)?API_KEY\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}/.test(bytes.toString()) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString())) throw new Error('Credential-like content found in frontend assets')
  assetManifest.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
  imports += `import asset${index} from ${JSON.stringify(relative(generated, file).replaceAll('\\', '/'))} with { type: 'file' };\n`
  mapping.push(`${JSON.stringify(path)}: asset${index}`)
}
await writeFile(join(generated, 'assets.ts'), imports + `export const assets: Record<string,string> = {${mapping.join(',')}};\n`)
const sidecar = join(binaries, `studio-service-${target}${windows ? '.exe' : ''}`)
await run([process.execPath, '--no-env-file', 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', '--env=disable', '--define', 'STUDIO_DESKTOP_BUILD=true', `--target=${targets[target]}`, '--outfile', sidecar, 'server/desktop-entry.ts'])
if (!windows) await chmod(sidecar, 0o755)
console.log('Compiled self-contained desktop service for ' + target)
if (sidecarOnly) process.exit(0)

const bundles = windows ? 'nsis' : mac ? 'dmg' : 'appimage,deb'
await run([process.execPath, '--no-env-file', join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build', '--target', target, '--bundles', bundles], join(root, 'desktop'))
const nativeRelease = join(root, 'desktop', 'src-tauri', 'target', target, 'release')
const output = join(root, 'releases', target)
await mkdir(output, { recursive: true })
// Stage into a fresh directory every run; no personal profile or previous build
// files can leak into an archive through a directory-wide copy.
const stage = join(output, `portable-${Date.now()}`, 'Civitai Studio')
await mkdir(stage, { recursive: true })
const staged: string[] = []
async function stageFile(source: string, filename: string) { await copyFile(source, join(stage, filename)); staged.push(filename) }
if (mac) {
  const app = 'Civitai Studio.app'
  await run(['ditto', join(nativeRelease, 'bundle', 'macos', app), join(stage, app)])
  staged.push(app)
} else {
  await stageFile(join(nativeRelease, `civitai-studio-desktop${windows ? '.exe' : ''}`), windows ? 'Civitai Studio.exe' : 'civitai-studio')
  await stageFile(sidecar, windows ? 'studio-service.exe' : 'studio-service')
  if (!windows) { await chmod(join(stage, 'civitai-studio'), 0o755); await chmod(join(stage, 'studio-service'), 0o755) }
}
await stageFile(join(root, 'desktop', 'START-HERE.txt'), 'START HERE.txt')
await stageFile(join(root, 'desktop', 'THIRD-PARTY-NOTICES.txt'), 'THIRD-PARTY-NOTICES.txt')
await mkdir(join(stage, 'licenses'), { recursive: true })
for (const file of await files(join(root, 'desktop', 'licenses'))) await stageFile(file, join('licenses', relative(join(root, 'desktop', 'licenses'), file)))
const archive = join(output, `Civitai-Studio-${version}-${target}${windows || mac ? '.zip' : '.tar.gz'}`)
if (windows) {
  await unlink(archive).catch(error => { if (error.code !== 'ENOENT') throw error })
  await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:CIVITAI_RELEASE_STAGE, $env:CIVITAI_RELEASE_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $true)'], root, { ...buildEnv, CIVITAI_RELEASE_STAGE: stage, CIVITAI_RELEASE_ARCHIVE: archive })
}
else if (mac) await run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', stage, archive])
else await run(['tar', '-czf', archive, '-C', resolve(stage, '..'), 'Civitai Studio'])
const released = [archive]
for (const file of await files(join(nativeRelease, 'bundle'))) {
  if (!['.exe', '.msi', '.dmg', '.deb', '.AppImage', '.rpm'].includes(extname(file)) || !file.includes(version)) continue
  const destination = join(output, file.slice(file.lastIndexOf(process.platform === 'win32' ? '\\' : '/') + 1))
  await copyFile(file, destination); released.push(destination)
}
const releaseFiles = await Promise.all(released.map(async file => { const bytes = await readFile(file); return { filename: relative(output, file), bytes: bytes.length, sha256: sha256(bytes) } }))
await writeFile(join(output, 'SHA256SUMS'), releaseFiles.map(file => `${file.sha256}  ${file.filename}`).join('\n') + '\n')
await writeFile(join(output, 'release-manifest.json'), JSON.stringify({ version, target, unsigned: true, frontend: assetManifest, portableAllowlist: staged, files: releaseFiles }, null, 2) + '\n')
console.log('Desktop beta artifacts: ' + output)
