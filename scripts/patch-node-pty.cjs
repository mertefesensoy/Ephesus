/**
 * Windows-only build fixes for node-pty so `postinstall` (electron-rebuild) succeeds
 * on this toolchain. Idempotent; no-ops on non-Windows / absent node-pty.
 * See docs/DECISIONS-LOG.md (2026-08-26). Two patches:
 *
 * 1. winpty.gyp invokes helper .bat files by bare name (`cd shared && X.bat`);
 *    current Windows 11 builds removed the current directory from cmd's
 *    executable search, so configure dies with "not recognized". Prefix `.\`.
 * 2. node-pty's gyp files request Spectre-mitigated MSVC libraries
 *    (SpectreMitigation: Spectre), an optional VS component this machine's
 *    Visual Studio does not have — MSB8040 kills the build. Dropping the flag
 *    builds against the standard libs; mitigation is a hardening nicety for a
 *    local terminal helper, not a functional requirement.
 */
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') process.exit(0)

const root = path.join(__dirname, '..', 'node_modules', 'node-pty')
const targets = [
  path.join(root, 'binding.gyp'),
  path.join(root, 'deps', 'winpty', 'src', 'winpty.gyp')
]

for (const gypPath of targets) {
  if (!fs.existsSync(gypPath)) continue
  const src = fs.readFileSync(gypPath, 'utf8')
  const patched = src
    .replace(/cd shared && (?!\.\\)(\w+\.bat)/g, 'cd shared && .\\\\$1')
    .replace(/^(\s*)'SpectreMitigation':\s*'Spectre',?\s*$/gm, "$1'SpectreMitigation': 'false'")
  if (patched !== src) {
    fs.writeFileSync(gypPath, patched)
    console.log(`patch-node-pty: patched ${path.relative(root, gypPath)}`)
  } else {
    console.log(`patch-node-pty: ${path.relative(root, gypPath)} — nothing to patch`)
  }
}
