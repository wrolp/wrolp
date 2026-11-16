// Self-check for the extension-less / unknown-extension language detection.
//
// Run with:  node tests/check-lang-detect.mjs
//
// `src/editor/languages.ts` is a pure module (no imports), so Node's type
// stripping can load it directly.

import assert from 'node:assert/strict'
import {
  LANGUAGE_OPTIONS,
  detectLanguage,
  detectLanguageForFile,
  detectLanguageFromText,
} from '../src/editor/languages.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const ids = new Set(LANGUAGE_OPTIONS.map((o) => o.id))

// ---- Filename conventions ---------------------------------------------------

check('extensions keep working', () => {
  assert.equal(detectLanguage('main.rs'), 'rust')
  assert.equal(detectLanguage('/home/me/notes.md'), 'markdown')
})

check('known names with a version suffix', () => {
  assert.equal(detectLanguage('Dockerfile'), 'dockerfile')
  assert.equal(detectLanguage('Dockerfile.dev'), 'dockerfile')
  assert.equal(detectLanguage('api.dockerfile'), 'dockerfile')
  assert.equal(detectLanguage('Makefile'), 'makefile')
  assert.equal(detectLanguage('GNUmakefile'), 'makefile')
})

check('shell rc files that carry no extension', () => {
  for (const name of ['.bashrc', '.zshrc', '.profile', '.kshrc', 'PKGBUILD', '.envrc']) {
    assert.equal(detectLanguage(name), 'shell', name)
  }
})

check('Ruby by convention', () => {
  for (const name of ['Gemfile', 'Rakefile', 'Vagrantfile', 'Podfile']) {
    assert.equal(detectLanguage(name), 'ruby', name)
  }
})

check('ini dotfiles and sectioned config files', () => {
  assert.equal(detectLanguage('.editorconfig'), 'ini')
  assert.equal(detectLanguage('.gitconfig'), 'ini')
  assert.equal(detectLanguage('sshd.service'), 'ini')
  assert.equal(detectLanguage('app.timer'), 'ini')
  assert.equal(detectLanguage('wrolp.desktop'), 'ini')
})

check('ssh config files', () => {
  assert.equal(detectLanguage('ssh_config'), 'sshconfig')
  assert.equal(detectLanguage('sshd_config'), 'sshconfig')
  assert.equal(detectLanguage('/etc/ssh/ssh_config'), 'sshconfig')
  assert.equal(detectLanguage('/home/me/.ssh/config'), 'sshconfig')
  assert.equal(detectLanguage('/etc/ssh/sshd_config.d/10-hardening.conf'), 'sshconfig')
  // A bare `config` outside `.ssh` is some project's file, not an SSH config.
  assert.equal(detectLanguage('config'), 'plaintext')
  // A real extension still wins over the convention name.
  assert.equal(detectLanguage('ssh_config.py'), 'python')
})

check('dot-env variants are property files', () => {
  assert.equal(detectLanguage('.env'), 'properties')
  assert.equal(detectLanguage('.env.local'), 'properties')
  assert.equal(detectLanguage('.env.production'), 'properties')
})

check('a plain name stays plaintext', () => {
  assert.equal(detectLanguage('notes'), 'plaintext')
  assert.equal(detectLanguage('dir/blob.unknownext'), 'plaintext')
})

// ---- Shebangs ---------------------------------------------------------------

check('classic shebangs', () => {
  assert.equal(detectLanguageFromText('#!/bin/sh\nset -e\n'), 'shell')
  assert.equal(detectLanguageFromText('#!/usr/bin/python3\nprint(1)\n'), 'python')
  assert.equal(detectLanguageFromText('#!/usr/bin/ruby\nputs 1\n'), 'ruby')
})

check('env shebangs, including -S, flags and assignments', () => {
  assert.equal(detectLanguageFromText('#!/usr/bin/env python3\n'), 'python')
  assert.equal(
    detectLanguageFromText('#!/usr/bin/env -S node --enable-source-maps\n'),
    'javascript',
  )
  assert.equal(detectLanguageFromText('#!/usr/bin/env FOO=bar bash -e\n'), 'shell')
})

check('versioned interpreters', () => {
  assert.equal(detectLanguageFromText('#!/usr/bin/python3.12\n'), 'python')
  assert.equal(detectLanguageFromText('#!/usr/bin/env python2.7\n'), 'python')
})

check('an unknown interpreter is not guessed', () => {
  assert.equal(detectLanguageFromText('#!/usr/bin/fish\n'), null)
  assert.equal(detectLanguageFromText('not a shebang\n'), null)
})

// ---- Modelines --------------------------------------------------------------

check('vim modelines', () => {
  assert.equal(detectLanguageFromText('# vim: ft=python\n'), 'python')
  assert.equal(detectLanguageFromText('/* vim: set filetype=cpp: */\n'), 'cpp')
  assert.equal(detectLanguageFromText('# ex: filetype=ruby\n'), 'ruby')
})

check('emacs modelines', () => {
  assert.equal(detectLanguageFromText('; -*- mode: yaml; -*-\n'), 'yaml')
  assert.equal(detectLanguageFromText('-*- python -*-\n'), 'python')
})

check('a modeline on the last lines still counts', () => {
  const filler = 'x'.repeat(9000)
  assert.equal(detectLanguageFromText(`${filler}\n# vim: ft=lua\n`), 'lua')
})

check('an unsupported editor mode is ignored', () => {
  assert.equal(detectLanguageFromText('# vim: ft=objc\n'), null)
})

// ---- First-line markup ------------------------------------------------------

check('markup declarations', () => {
  assert.equal(detectLanguageFromText('<?xml version="1.0"?>\n<a/>\n'), 'xml')
  assert.equal(detectLanguageFromText('<svg xmlns="…"></svg>\n'), 'xml')
  assert.equal(detectLanguageFromText('<!doctype html>\n<html></html>\n'), 'html')
  assert.equal(detectLanguageFromText('<?php echo 1;\n'), 'php')
})

// ---- Composition rules ------------------------------------------------------

check('a known extension always wins over content', () => {
  assert.equal(detectLanguageForFile('app.py', '#!/bin/bash\necho hi\n'), 'python')
  assert.equal(detectLanguageForFile('unit.service', '#!/bin/bash\n'), 'ini')
})

check('content fills in for an unknown name', () => {
  assert.equal(detectLanguageForFile('deploy', '#!/usr/bin/env python3\n'), 'python')
  assert.equal(detectLanguageForFile('blob.unknownext', '<?xml version="1.0"?>'), 'xml')
  assert.equal(detectLanguageForFile('notes', 'just words\n'), 'plaintext')
})

check('every guess lands on a picker id', () => {
  const guesses = [
    detectLanguage('Gemfile'),
    detectLanguageFromText('#!/usr/bin/env node\n'),
    detectLanguageFromText('# vim: ft=make\n'),
    detectLanguageFromText('<!doctype html>'),
  ]
  for (const id of guesses) assert.ok(id === null || ids.has(id), String(id))
})

console.log(`\n${checks} checks passed`)
