// Runs the prompts of a review/fix iteration through Claude Code, all in one
// session per repository, and streams what Claude is doing to the window. One
// run at a time: starting another stops the first.
//
// The session is carried from one run to the next with --resume, using the id
// Claude itself reported last — so a Claude that moves a resumed conversation
// onto a new id is followed there. A repository with no session yet starts one
// with its first prompt; newSession forgets it, which is what /clear would do,
// without spending a run on saying so.
//
// Events sent to the renderer, each tagged with the runId run() was given:
//   status  { runId, text }                        a line of progress
//   done    { runId, text, summary, sessionId }    the answer, and a one-line footer
//   error   { runId, message }                     it failed, or was cancelled
import { runClaude } from '../lib/claude.js'
import { DEFAULT_REVIEW_PROMPT } from './plugin.js'

// Only ever put into the shell script as a word of its own, but it arrives from
// Claude's output, so it is checked before that happens.
const SESSION_ID = /^[\w-]+$/

export default function activate(ctx) {
  let current = null // { cancel } of the run under way
  // repository root → the session id to resume there
  const sessions = new Map()

  const stop = () => {
    current?.cancel()
    current = null
  }

  // kind: 'review' — the review prompt from the settings
  //       'fix'    — `prompt`, the decisions made on the last review's findings
  //       'compact'— /compact, to keep a long run of iterations within context
  ctx.handle('run', (runId, kind, prompt) => {
    const { root } = ctx.getRepo()
    if (!root) throw new Error('No repository is open.')
    const settings = ctx.getSettings()
    const executable = settings.executable.trim()
    if (!executable) throw new Error('Set the Claude executable in Settings first.')

    let text
    let extraArgs = settings.extraArgs
    if (kind === 'review') {
      text = settings.prompt.trim() || DEFAULT_REVIEW_PROMPT
    } else if (kind === 'fix') {
      text = String(prompt ?? '').trim()
      if (!text) throw new Error('There is nothing to send.')
      extraArgs = `${extraArgs} ${settings.fixArgs}`
    } else if (kind === 'compact') {
      if (!sessions.has(root)) throw new Error('There is no session to compact.')
      text = '/compact'
    } else {
      throw new Error(`Unknown kind of run: ${kind}`)
    }

    const sessionId = sessions.get(root)
    if (sessionId) extraArgs = `--resume ${sessionId} ${extraArgs}`

    stop()
    const emit = (channel, payload) => ctx.send(channel, { runId, ...payload })

    const run = runClaude({
      executable,
      extraArgs,
      prompt: text,
      cwd: root,
      onStatus: (line) => emit('status', { text: line }),
      onSession: (id) => {
        // Not once the session has been cleared: a run cancelled by that still
        // reports on its way out, and would bring the old session back.
        if (run.cleared || !SESSION_ID.test(id)) return
        sessions.set(root, id)
      }
    })
    current = run
    run.result
      .then(
        (answer) => emit('done', { ...answer, sessionId: sessions.get(root) ?? null }),
        (err) => emit('error', { message: err.message })
      )
      .finally(() => {
        if (current === run) current = null
      })
  })

  ctx.handle('cancel', stop)

  ctx.handle('session', () => ({ sessionId: sessions.get(ctx.getRepo().root) ?? null }))

  ctx.handle('newSession', () => {
    if (current) current.cleared = true
    stop()
    sessions.delete(ctx.getRepo().root)
  })

  ctx.on('quit', stop)
}
