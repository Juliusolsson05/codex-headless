import { access, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const root = process.cwd()
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const extraFiles = []
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--require' && process.argv[index + 1]) {
    extraFiles.push(process.argv[index + 1])
    index += 1
  }
}

function collectEntrypoints(value, entries) {
  if (typeof value === 'string') entries.add(value.replace(/^\.\//, ''))
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectEntrypoints(nested, entries)
  }
}

const required = new Set(extraFiles)
collectEntrypoints(manifest.main, required)
collectEntrypoints(manifest.types, required)
collectEntrypoints(manifest.exports, required)
collectEntrypoints(manifest.bin, required)

const packResult = JSON.parse(execFileSync(
  'npm',
  ['pack', '--json', '--dry-run', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8' },
))
const packed = new Set(packResult[0]?.files?.map((file) => file.path) ?? [])
const failures = []

for (const file of packed) {
  if (/(?:^|\.)(?:test|spec)(?:\.d)?\.[cm]?[jt]sx?(?:\.map)?$/.test(file)) {
    failures.push(file + ' is a test artifact and must not ship in the package')
  }
}

for (const file of required) {
  try {
    await access(join(root, file))
  } catch {
    failures.push(`${file} does not exist after build`)
    continue
  }
  if (!packed.has(file)) failures.push(`${file} is missing from npm pack output`)
}

if (manifest.main) {
  try {
    await import(pathToFileURL(join(root, manifest.main)).href)
  } catch (error) {
    failures.push(`public main entry point cannot be imported: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('Package smoke test failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Packed artifact exposes ${required.size} required files`)
}
