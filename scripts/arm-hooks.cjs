#!/usr/bin/env node
/**
 * Point git at `.githooks/` so the attribution tripwire (ENGINEERING-STANDARDS §2)
 * runs on every commit in this clone. `core.hooksPath` is per-clone config and cannot
 * be committed, so `postinstall` arms it — the hooks are useless in the checkout where
 * they matter otherwise.
 *
 * Never fatal: a tarball install or a hookless environment is not a build failure.
 */
const { execFileSync } = require('node:child_process')

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
} catch {
  console.log('not a git checkout — attribution hooks not armed')
  process.exit(0)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
  console.log('attribution hooks armed (core.hooksPath=.githooks)')
} catch (error) {
  console.warn(`could not arm .githooks — commit attribution is CI-checked only: ${error.message}`)
}
