import { describe, expect, mock, test } from 'claude-code/testing'

import { expand, listing, parseSkill } from './register'

const HANDOFF = `---
name: moxen-handoff
description: Hand the current conversation off to a fresh thread in Moxen.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

# Handoff

Use $ARGUMENTS.
`

const THREADS = `---
description: >-
  Work with Moxen threads. Use when the task needs
  moxen threads create or list.
---
Body of threads.`

type Files = Record<string, string>
const tree = (files: Files) => ({
  list: (dir: string) =>
    [...new Set(Object.keys(files).filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1).split('/')[0]!))].map((name) => ({
      name,
      kind: 'dir' as const,
      size: 0,
      isLink: false,
    })),
  exists: (path: string) => path in files,
  read: (path: string) => files[path]!,
})

describe('skill files', () => {
  test('reads frontmatter, folded descriptions and the body', () => {
    const handoff = parseSkill(HANDOFF)
    expect(handoff.meta['disable-model-invocation']).toBe('true')
    expect(handoff.meta['argument-hint']).toBe('What will the next session be used for?')
    expect(handoff.body.startsWith('# Handoff')).toBe(true)
    expect(parseSkill(THREADS).meta.description).toBe('Work with Moxen threads. Use when the task needs moxen threads create or list.')
    expect(parseSkill('no frontmatter').body).toBe('no frontmatter')
  })

  test('fills $ARGUMENTS, or appends them when the skill has no slot', () => {
    const skill = { name: 'a', description: '', argumentHint: null, dir: '/s/a', body: 'Do $ARGUMENTS now', userOnly: false, modelOnly: false }
    expect(expand(skill, 'x')).toBe('Base directory for this skill: /s/a\n\nDo x now')
    expect(expand({ ...skill, body: 'Do it' }, 'x')).toContain('ARGUMENTS: x')
    expect(expand({ ...skill, body: 'Do it' }, '')).not.toContain('ARGUMENTS')
  })

  test('lists only what Claude may load, within a budget', () => {
    const base = { argumentHint: null, dir: '/s', body: '', modelOnly: false }
    const text = listing([
      { ...base, name: 'one', description: 'First', userOnly: false },
      { ...base, name: 'two', description: 'User only', userOnly: true },
    ])
    expect(text).toBe('- one: First')
  })
})

describe('serving skills', () => {
  test('finds project, home and bundled skills, project first, and registers a tool and commands', async ($, on) => {
    const files: Files = {
      '/proj/.agents/skills/moxen-threads/SKILL.md': THREADS,
      '/home/u/.agents/skills/moxen-threads/SKILL.md': '---\ndescription: Home copy\n---\nhome',
      '/home/u/.agents/skills/mine/SKILL.md': '---\ndescription: Mine\n---\nmine',
      '/bundled/moxen-handoff/SKILL.md': HANDOFF,
      '/proj/.claude/skills/already/SKILL.md': 'x',
      '/proj/.agents/skills/already/SKILL.md': 'x',
    }
    const fs = tree(files)
    mock.env(on, { HOME: '/home/u', MOXEN_SKILLS_DIR: '/bundled' })
    const registered: string[] = []
    on('fs.list', async (_$, e) => ({ value: fs.list((e as { path: string }).path) }))
    on('fs.exists', async (_$, e) => ({ value: fs.exists((e as { path: string }).path) }))
    on('fs.read', async (_$, e) => ({ value: fs.read((e as { path: string }).path) }))
    on('tool.register', async (_$, e) => {
      registered.push(`tool:${(e as { description: string }).description}`)
      return { value: undefined as never }
    })
    on('command.register', async (_$, e) => {
      registered.push(`command:${(e as { name: string }).name}`)
      return { value: undefined as never }
    })

    // The engine's own session.start answers beneath the plugin.
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })

    const tool = registered.find((entry) => entry.startsWith('tool:'))!
    expect(tool).toContain('- moxen-threads: Work with Moxen threads.')
    expect(tool).toContain('- mine: Mine')
    // Project beats home for the same name; the user-only skill is not offered to Claude.
    expect(tool).not.toContain('Home copy')
    expect(tool).not.toContain('moxen-handoff')
    // Claude Code already has `already` in .claude/skills.
    expect(tool).not.toContain('already')
    expect(registered.filter((entry) => entry.startsWith('command:')).sort()).toEqual(['command:mine', 'command:moxen-handoff', 'command:moxen-threads'])
  })
})
