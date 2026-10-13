import type { Register } from 'claude-code'

/**
 * Skills that live outside `.claude/skills`, served to Claude Code.
 *
 * `.agents/skills` is the folder Codex, OpenCode and Grok read; Claude Code
 * reads only `.claude/skills`. Instead of copying or linking every skill into
 * `.claude/skills` (and keeping the copies current), this mod finds them where
 * they are and offers them two ways:
 *
 *   - to Claude, as one tool whose description lists the skills and whose call
 *     returns a skill's instructions (what the built-in Skill tool does);
 *   - to the person, as a `/<name>` command that runs the skill.
 *
 * Looked up, first match wins by name: `<project>/.agents/skills`,
 * `~/.agents/skills`, then the folder named by `MOXEN_SKILLS_DIR` (Moxen's own
 * bundled skills, which it sets for the sessions it starts). A skill that
 * `.claude/skills` already provides is left to Claude Code.
 */

type Skill = {
  name: string
  description: string
  argumentHint: string | null
  dir: string
  body: string
  /** `disable-model-invocation: true`: only the person runs it. */
  userOnly: boolean
  /** `user-invocable: false`: only Claude runs it. */
  modelOnly: boolean
}

const TOOL = 'skill'
const TOOL_FULL_NAME = 'mcp__agent-skills__skill'
/** Keeps the tool description, which rides in every request, to a size worth sending. */
const LISTING_BUDGET = 8_000
const DESCRIPTION_CAP = 250

/** Splits `---` frontmatter from the body and reads its flat `key: value` lines (and `>`/`|` blocks). */
export function parseSkill(text: string): { meta: Record<string, string>; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { meta: {}, body: text.trim() }
  const end = lines.indexOf('---', 1)
  if (end === -1) return { meta: {}, body: text.trim() }
  const meta: Record<string, string> = {}
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index] ?? '')
    if (!match) continue
    const key = match[1]!
    let value = match[2]!.trim()
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = []
      while (index + 1 < end && /^\s+\S/.test(lines[index + 1] ?? '')) {
        index += 1
        parts.push((lines[index] ?? '').trim())
      }
      value = parts.join(' ')
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    meta[key] = value
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() }
}

/** The text a skill run hands over: `$ARGUMENTS` filled in, or the arguments appended when the skill has no slot. */
export function expand(skill: Skill, args: string): string {
  const given = args.trim()
  let text = skill.body.replace(/\$ARGUMENTS\b/g, given)
  if (given !== '' && !skill.body.includes('$ARGUMENTS')) text += `\n\nARGUMENTS: ${given}`
  return `Base directory for this skill: ${skill.dir}\n\n${text}`
}

export function listing(skills: readonly Skill[]): string {
  const lines: string[] = []
  let used = 0
  for (const skill of skills) {
    if (skill.userOnly) continue
    const description = skill.description.length > DESCRIPTION_CAP ? `${skill.description.slice(0, DESCRIPTION_CAP - 1)}…` : skill.description
    const line = `- ${skill.name}: ${description}`
    if (used + line.length > LISTING_BUDGET) {
      lines.push(`- …and ${skills.filter((entry) => !entry.userOnly).length - lines.length} more (call the tool with a name to load one)`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

export const register: Register = (on) => {
  let skills: Skill[] = []

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const bundled = (await $.env.get('MOXEN_SKILLS_DIR')) ?? ''
    const roots = [`${e.cwd}/.agents/skills`, home === '' ? '' : `${home}/.agents/skills`, bundled].filter((root) => root !== '')
    const claudeRoots = [`${e.cwd}/.claude/skills`, home === '' ? '' : `${home}/.claude/skills`].filter((root) => root !== '')

    const found = new Map<string, Skill>()
    for (const root of roots) {
      let entries: Awaited<ReturnType<typeof $.fs.list>> = []
      try {
        entries = await $.fs.list(root)
      } catch {
        continue
      }
      for (const entry of entries) {
        // A symlink reads as `other` (users link skills in); anything that is not a plain file may hold one.
        if (entry.kind === 'file' || found.has(entry.name)) continue
        const dir = `${root}/${entry.name}`
        const file = `${dir}/SKILL.md`
        if (!(await $.fs.exists(file))) continue
        let provided = false
        for (const claudeRoot of claudeRoots) provided ||= await $.fs.exists(`${claudeRoot}/${entry.name}/SKILL.md`)
        if (provided) continue
        try {
          const { meta, body } = parseSkill(await $.fs.read(file))
          const name = meta.name && /^[\w-]{1,64}$/.test(meta.name) ? meta.name : entry.name
          if (found.has(name)) continue
          found.set(name, {
            name,
            description: meta.description ?? `The ${name} skill`,
            argumentHint: meta['argument-hint'] ?? null,
            dir,
            body,
            userOnly: meta['disable-model-invocation'] === 'true',
            modelOnly: meta['user-invocable'] === 'false',
          })
        } catch {
          // An unreadable skill is skipped, not fatal.
        }
      }
    }
    skills = [...found.values()].sort((left, right) => left.name.localeCompare(right.name))

    if (skills.some((skill) => !skill.userOnly)) {
      await $.tool.register({
        name: TOOL,
        description:
          'Load a skill from .agents/skills: instructions for a kind of task. When a task matches one below, call this first with its name, ' +
          'then follow what it returns. Skills listed here are not in the built-in Skill tool.\n\nAvailable skills:\n' +
          listing(skills),
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'The skill name, as listed.' },
            args: { type: 'string', description: 'Arguments for the skill, when it takes any.' },
          },
          required: ['skill'],
        },
      })
    }
    // Registered last: a name a built-in command holds throws, and that must not cost the rest.
    for (const skill of skills) {
      if (skill.modelOnly) continue
      try {
        await $.command.register({
          name: skill.name,
          description: skill.description.length > 120 ? `${skill.description.slice(0, 119)}…` : skill.description,
          ...(skill.argumentHint === null ? {} : { argumentHint: skill.argumentHint }),
        })
      } catch {
        // Taken by a built-in or another mod: that one wins.
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL_FULL_NAME }, async ($, e) => {
    const input = e as unknown as { skill?: unknown; args?: unknown }
    const wanted = typeof input.skill === 'string' ? input.skill.trim().replace(/^\//, '') : ''
    const skill = skills.find((entry) => entry.name === wanted)
    if (!skill) {
      const names = skills.filter((entry) => !entry.userOnly).map((entry) => entry.name).join(', ')
      return { result: `No skill named "${wanted}". Available: ${names}` }
    }
    if (skill.userOnly) return { result: `The ${skill.name} skill can only be run by the user, with /${skill.name}.` }
    return { result: expand(skill, typeof input.args === 'string' ? input.args : '') }
  }).catch(async (_$, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    const skill = skills.find((entry) => entry.name === e.command && !entry.modelOnly)
    if (!skill) return next(e)
    // The skill is the person's request: it starts a turn, as the built-in /skill commands do.
    await $.prompt.submit({ text: expand(skill, e.args), asUser: true })
    return {}
  }).catch(async (_$, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!skills.some((skill) => !skill.userOnly)) return result
    return {
      sections: [
        ...result.sections,
        {
          id: 'agent-skills:guide',
          scope: 'session' as const,
          text: `Skills in .agents/skills are loaded with the ${TOOL_FULL_NAME} tool, not the Skill tool. When the user's request matches one, load it first and follow it.`,
        },
      ],
    }
  })
}
