import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const repository = 'Nocturne-Ai-Labs/civitai-studio'
const targets: Record<string, string> = { 'x86_64-pc-windows-msvc': 'windows-x86_64', 'aarch64-apple-darwin': 'darwin-aarch64', 'x86_64-apple-darwin': 'darwin-x86_64', 'x86_64-unknown-linux-gnu': 'linux-x86_64' }
const safeName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Ed25519 and BLAKE2b are provided by the runtime's cryptographic library.
// Match Minisign's prehashed format and verify the trusted version comment too.
export function verifyUpdaterSignature(bytes: Uint8Array, signature: string, publicKey: string, version: string, filename?: string) {
  const publicLines = Buffer.from(publicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const key = Buffer.from(publicLines.at(-1) ?? '', 'base64')
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || lines.length !== 4 || !lines[2]!.startsWith('trusted comment: ')) throw new Error('Invalid updater signing format')
  const record = Buffer.from(lines[1]!, 'base64'), global = Buffer.from(lines[3]!, 'base64'), comment = lines[2]!.slice('trusted comment: '.length)
  if (record.length !== 74 || !['ED', 'Ed'].includes(record.subarray(0, 2).toString()) || global.length !== 64 || !record.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('Updater signature does not match the pinned key')
  if (comment.split('\t').find(field => field.startsWith('version:'))?.slice(8) !== version) throw new Error('Updater signature is not bound to the announced version')
  if (filename && comment.split('\t').find(field => field.startsWith('file:'))?.slice(5) !== filename) throw new Error('Updater signature is not bound to its platform package')
  const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
  const digest = record.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes, signed = record.subarray(10)
  if (!verify(null, digest, publicObject, signed) || !verify(null, Buffer.concat([signed, Buffer.from(comment)]), publicObject, global)) throw new Error('Updater package signature verification failed')
}

export async function generateUpdateManifest(paths: string[], output: string, notes = '') {
  if (paths.length !== 4) throw new Error('Provide exactly four release-manifest.json files')
  const root = resolve(import.meta.dir, '..'), expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(expectedVersion)) throw new Error('A beta release version is required')
  if (Buffer.byteLength(notes) > 16384) throw new Error('Release notes must fit in 16 KiB')
  const publicKey = await readFile(join(root, 'desktop', 'src-tauri', 'updater-public-key.txt'), 'utf8')
  const platforms: Record<string, { url: string; signature: string }> = {}, seen = new Set<string>()
  for (const path of paths) {
    if ((await lstat(path)).size > 1024 * 1024) throw new Error('Release manifest exceeded its limit')
    const manifest = JSON.parse(await readFile(path, 'utf8')), updater = manifest.updater, platform = targets[manifest.target]
    if (!platform || seen.has(platform) || manifest.version !== expectedVersion || !updater || updater.platform !== platform || updater.signedVersion !== expectedVersion || !Array.isArray(manifest.files)) throw new Error('Release targets, versions, and signatures must agree')
    if (!safeName(updater.filename) || !safeName(updater.signatureFilename) || updater.signatureFilename !== updater.filename + '.sig' || typeof updater.signature !== 'string' || updater.signature.length > 4096) throw new Error('Use safe canonical updater filenames with matching .sig files')
    const packagePath = join(dirname(path), updater.filename), signaturePath = join(dirname(path), updater.signatureFilename)
    for (const [item, limit] of [[packagePath, 512 * 1024 * 1024], [signaturePath, 4096]] as const) { const metadata = await lstat(item); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) throw new Error('Updater assets must be bounded regular files') }
    const bytes = await readFile(packagePath), signatureBytes = await readFile(signaturePath), signature = signatureBytes.toString('utf8').trim()
    if (!bytes.length || bytes.length > 512 * 1024 * 1024 || bytes.length !== updater.bytes || sha256(bytes) !== updater.sha256 || signature !== updater.signature) throw new Error('Updater asset differs from the release manifest')
    for (const [name, content] of [[updater.filename, bytes], [updater.signatureFilename, signatureBytes]] as const) {
      const file = manifest.files.find((entry: { filename: string }) => entry.filename === name)
      if (!file || file.bytes !== content.length || file.sha256 !== sha256(content)) throw new Error('Signed updater assets must appear in the release checksums')
    }
    const publicPlatform = platform.startsWith('darwin') ? platform.endsWith('aarch64') ? 'macos-apple-silicon' : 'macos-intel' : platform.startsWith('windows') ? 'windows-x64' : 'linux-x64'
    const extension = platform.startsWith('darwin') ? '.app.tar.gz' : platform.startsWith('windows') ? '-setup.exe' : '.AppImage'
    if (updater.filename !== `Civitai-Studio-${expectedVersion}-${publicPlatform}${extension}`) throw new Error('Incorrect canonical updater package for ' + platform)
    verifyUpdaterSignature(bytes, signature, publicKey, expectedVersion, updater.filename)
    platforms[platform] = { url: `https://github.com/${repository}/releases/download/v${expectedVersion}/${updater.filename}`, signature }
    seen.add(platform)
  }
  const manifest = { version: expectedVersion, notes: notes || `Civitai Studio ${expectedVersion}`, pub_date: new Date().toISOString(), platforms }
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n')
  return { version: expectedVersion, platforms: Object.keys(platforms).sort(), output }
}

if (import.meta.main) {
  const args = process.argv.slice(2), outputIndex = args.indexOf('--output'), notesIndex = args.indexOf('--notes-file')
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('Usage: desktop:update-manifest <four manifest paths> --output <latest.json> [--notes-file <text>]')
  const output = args[outputIndex + 1]!, notes = notesIndex >= 0 ? await readFile(args[notesIndex + 1] ?? '', 'utf8') : ''
  const paths = args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1 && (notesIndex < 0 || index !== notesIndex && index !== notesIndex + 1))
  console.log(JSON.stringify(await generateUpdateManifest(paths, output, notes)))
}
