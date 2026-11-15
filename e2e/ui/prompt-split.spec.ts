import { test, expect } from '@playwright/test'
import { splitPromptCommand } from '../../src/components/terminal/promptLine'

test.describe('splitPromptCommand prompt glyphs', () => {
  test('a decorative glyph is split off the command', () => {
    for (const glyph of ['\uf054', '➜', '❮', 'λ']) {
      expect(splitPromptCommand(`${glyph}  ls`)).toEqual({ prompt: `${glyph}  `, command: 'ls' })
    }
  })

  test('the known markers keep winning', () => {
    expect(splitPromptCommand('❯ ls')).toEqual({ prompt: '❯ ', command: 'ls' })
    expect(splitPromptCommand('[root@sip /srv]# ls')).toEqual({
      prompt: '[root@sip /srv]# ',
      command: 'ls',
    })
  })

  test('a glyph prompt carrying a path is left alone', () => {
    // robbyrussell renders the cwd after the glyph; splitting there would
    // recolour (and record) the prompt's own path as a command.
    expect(splitPromptCommand('➜  /opt ls').prompt).toBe('')
    expect(splitPromptCommand('➜  ~/proj ls').prompt).toBe('')
    expect(splitPromptCommand('➜  ./run.sh').prompt).toBe('')
  })

  test('commands are never mistaken for glyphs', () => {
    expect(splitPromptCommand('git commit -m "中文"').prompt).toBe('')
    expect(splitPromptCommand('部署 ls').prompt).toBe('')
    expect(splitPromptCommand('').command).toBe('')
  })
})
