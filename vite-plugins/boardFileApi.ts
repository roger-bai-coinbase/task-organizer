import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'

const DATA_FILE = path.join(process.cwd(), '.local-data', 'board.json')
const EVENTS_FILE = path.join(process.cwd(), '.local-data', 'task-events.json')
const REPORT_DIR = path.join(process.cwd(), 'reports')
const ENV_FILE = path.join(process.cwd(), '.env')
const WEEKLY_REPORT_AI_TIMEOUT_MS = 60_000

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

type WeeklyReportAiOutcome = { markdown: string } | { error: string }

async function readLocalEnv(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ENV_FILE, 'utf8')
    const out: Record<string, string> = {}
    for (const line0 of raw.split(/\r?\n/)) {
      const line = line0.trim()
      if (!line || line.startsWith('#')) continue
      const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line
      const eq = cleaned.indexOf('=')
      if (eq < 0) continue
      const k = cleaned.slice(0, eq).trim()
      const v = cleaned.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function summarizeWithAi(input: {
  diffText: string
  weekLabel?: string
}): Promise<WeeklyReportAiOutcome> {
  const env = await readLocalEnv()
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    env.LLM_API_KEY ||
    env.OPENAI_API_KEY
  if (!apiKey) {
    return {
      error:
        'AI summarization failed. Check LLM_API_KEY / LLM_BASE_URL / LLM_MODEL (or OPENAI_* aliases) and server logs.',
    }
  }

  const system = [
    'You summarize engineering task diffs into concise weekly updates.',
    'Output markdown only.',
    'Formatting must match a Google-Doc-style nested bullet list (like a sprint retro "Updates" section).',
    'Hard rules:',
    '- Do NOT use # or ## or ### or any ATX headings.',
    '- Use asterisk bullets only: each non-empty line starts with "* " (optionally indented with spaces before the asterisk).',
    '- Indent nesting with exactly 3 spaces per level before the asterisk (same pattern as Google Docs plain-text export).',
    'Suggested outline (all bullets, no headings):',
    '* Weekly Updates',
    '* Week: <verbatim week label if provided>',
    '* <Project title>',
    '   * <Task title>',
    '      * <concise update (one bullet per meaningful change)>',
    'Rules:',
    '- Group by project, then task, using the nesting above.',
    '- No "Discussion" or "Ticket Assignment" sections.',
    '- No per-event timestamps.',
    '- Keep each task update line short and human-readable.',
    '- At most 3 indented update bullets per task.',
    '- If a bullet has exactly one sub-bullet beneath it, merge them into a single bullet at the parent indent (one concise line); avoid a parent line plus a lone child that repeats or splits the same point.',
    '- Never say that notes were updated, that the description or task text was edited, or similar meta about changing fields. Summarize only substantive outcomes, facts, or decisions implied by the diff; do not describe the act of editing text.',
  ].join('\n')

  const user = `Week label: ${input.weekLabel ?? 'N/A'}\n\nDiff:\n${input.diffText}`
  const baseUrl = (
    process.env.LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    env.LLM_BASE_URL ||
    env.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'
  ).replace(/\/$/, '')
  const model =
    process.env.LLM_MODEL ||
    process.env.WEEKLY_REPORT_MODEL ||
    env.LLM_MODEL ||
    env.WEEKLY_REPORT_MODEL ||
    'gpt-4o-mini'
  const endpoints = new Set<string>()
  endpoints.add(`${baseUrl}/chat/completions`)
  if (!baseUrl.endsWith('/v1')) endpoints.add(`${baseUrl}/v1/chat/completions`)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WEEKLY_REPORT_AI_TIMEOUT_MS)
  try {
    for (const endpoint of endpoints) {
      let res: Response
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        })
      } catch (e: unknown) {
        if (isAbortError(e)) {
          console.warn(
            `[weekly-report] AI request aborted after ${WEEKLY_REPORT_AI_TIMEOUT_MS / 1000}s (timeout)`,
          )
          return { error: 'Report generation timed out after 60 seconds.' }
        }
        console.warn(`[weekly-report] AI fetch failed ${endpoint}:`, e)
        continue
      }
      if (!res.ok) {
        const body = await res.text()
        console.warn(
          `[weekly-report] AI endpoint failed ${endpoint} (${res.status}): ${body.slice(0, 240)}`,
        )
        continue
      }
      let json: { choices?: Array<{ message?: { content?: string } }> }
      try {
        json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
      } catch (e: unknown) {
        if (isAbortError(e)) {
          console.warn(
            `[weekly-report] AI request aborted after ${WEEKLY_REPORT_AI_TIMEOUT_MS / 1000}s (timeout)`,
          )
          return { error: 'Report generation timed out after 60 seconds.' }
        }
        console.warn(`[weekly-report] AI response JSON parse failed ${endpoint}:`, e)
        continue
      }
      const content = json.choices?.[0]?.message?.content?.trim()
      if (content && content.length > 0) return { markdown: content }
    }
  } finally {
    clearTimeout(timeoutId)
  }
  return {
    error:
      'AI summarization failed. Check LLM_API_KEY / LLM_BASE_URL / LLM_MODEL (or OPENAI_* aliases) and server logs.',
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function boardFileMiddleware() {
  return async (
    req: IncomingMessage,
    res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void },
    next: () => void,
  ) => {
    const url = (req.url ?? '').split('?')[0]
    if (
      url !== '/__board-api/state' &&
      url !== '/__board-api/task-events' &&
      url !== '/__board-api/weekly-report'
    ) {
      next()
      return
    }

    const dataFile =
      url === '/__board-api/state'
        ? DATA_FILE
        : url === '/__board-api/task-events'
          ? EVENTS_FILE
          : ''

    if (req.method === 'GET' && dataFile) {
      try {
        const raw = await fs.readFile(dataFile, 'utf8')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.statusCode = 200
        res.end(raw)
      } catch (e: unknown) {
        const code = e && typeof e === 'object' && 'code' in e ? (e as { code: string }).code : ''
        if (code === 'ENOENT') {
          res.statusCode = 404
          res.end()
        } else {
          res.statusCode = 500
          res.end()
        }
      }
      return
    }

    if (req.method === 'PUT' && dataFile) {
      try {
        const raw = await readBody(req)
        JSON.parse(raw)
        await fs.mkdir(path.dirname(dataFile), { recursive: true })
        await fs.writeFile(dataFile, raw, 'utf8')
        res.statusCode = 204
        res.end()
      } catch {
        res.statusCode = 400
        res.end()
      }
      return
    }

    if (req.method === 'POST' && url === '/__board-api/weekly-report') {
      try {
        const raw = await readBody(req)
        const body = JSON.parse(raw) as {
          diffText?: unknown
          weekLabel?: unknown
          suggestedFilename?: unknown
        }
        if (
          !body ||
          typeof body.diffText !== 'string' ||
          typeof body.suggestedFilename !== 'string'
        ) {
          res.statusCode = 400
          res.end()
          return
        }

        const aiOutcome = await summarizeWithAi({
          diffText: body.diffText,
          weekLabel: typeof body.weekLabel === 'string' ? body.weekLabel : undefined,
        })
        if ('error' in aiOutcome) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: aiOutcome.error }))
          return
        }
        const markdown = aiOutcome.markdown

        const base = path
          .basename(body.suggestedFilename)
          .replace(/[^a-zA-Z0-9._-]/g, '_')
        const filename = base.endsWith('.md') ? base : `${base}.md`

        await fs.mkdir(REPORT_DIR, { recursive: true })
        let finalPath = path.join(REPORT_DIR, filename)
        let suffix = 1
        while (true) {
          try {
            await fs.access(finalPath)
            const ext = path.extname(filename)
            const stem = path.basename(filename, ext)
            finalPath = path.join(REPORT_DIR, `${stem}-${suffix}${ext}`)
            suffix += 1
          } catch {
            break
          }
        }
        await fs.writeFile(finalPath, markdown, 'utf8')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.statusCode = 200
        res.end(
          JSON.stringify({
            path: path.relative(process.cwd(), finalPath),
            usedAi: true,
          }),
        )
      } catch {
        res.statusCode = 400
        res.end()
      }
      return
    }

    res.statusCode = 405
    res.end()
  }
}

export function boardFileApiPlugin(): Plugin {
  const mw = boardFileMiddleware()
  return {
    name: 'board-file-api',
    configureServer(server) {
      server.middlewares.use(mw)
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw)
    },
  }
}
