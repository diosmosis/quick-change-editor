// Runs the prompts of a review/fix iteration through Claude Code, all in one
// session per repository, and streams what Claude is doing to the window. One
// run at a time: starting another stops the first.
//
// The session is carried from one run to the next with --resume, using the id
// Claude itself reported last — so a Claude that moves a resumed conversation
// onto a new id is followed there. A repository with no session yet starts one
// with its first prompt; newSession forgets it, which is what /clear would do,
// without spending a run on saying so. The sessions are kept across restarts,
// so quitting mid-iteration and coming back carries on in the same one —
// separately for Claude and opencode, which cannot resume each other's.
//
// opencode (`opencode`, or `claudebox opencode`) has no /compact to send
// headless; it compacts a session itself when it nears the context limit, so
// with it the compact step is skipped.
//
// Events sent to the renderer, each tagged with the runId run() was given:
//   status  { runId, text }                        a line of progress
//   done    { runId, text, summary, sessionId, compacts }
//                                                  the answer, a one-line footer, and
//                                                  whether a compact should follow
//   error   { runId, message }                     it failed, or was cancelled
import { agentOf, permissionArgs, runClaude } from '../lib/claude.js'
import { DEFAULT_REVIEW_PROMPT } from './plugin.js'

// Passed to the agent as an argument of its own, but it arrives from the
// agent's output, so it is checked before it is kept.
const SESSION_ID = /^[\w-]+$/

export default function activate(ctx) {
  let current = null // { cancel } of the run under way
  // repository root → the session id to resume there
  const sessions = new Map(Object.entries(ctx.getData('sessions', {})))
  const saveSessions = () => ctx.setData('sessions', Object.fromEntries(sessions))
  // Claude's sessions are kept under the bare root, as they always were.
  const sessionKey = (root) =>
    agentOf(ctx.getSettings().executable).opencode ? `opencode:${root}` : root

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
    const key = sessionKey(root)

    // The fix arguments are Claude's permission modes, which neither claudebox
    // (unrestricted already) nor opencode (no such flags) takes.
    const { claudebox, opencode } = agentOf(executable)

    let text
    let extraArgs = `${permissionArgs(executable, settings.allowedTools)} ${settings.extraArgs}`
    if (kind === 'review') {
      text = settings.prompt.trim() || DEFAULT_REVIEW_PROMPT
    } else if (kind === 'fix') {
      text = String(prompt ?? '').trim()
      if (!text) throw new Error('There is nothing to send.')
      if (!claudebox && !opencode) extraArgs = `${extraArgs} ${settings.fixArgs}`
    } else if (kind === 'compact') {
      if (opencode) throw new Error('opencode compacts its sessions itself.')
      if (!sessions.has(key)) throw new Error('There is no session to compact.')
      text = '/compact'
    } else {
      throw new Error(`Unknown kind of run: ${kind}`)
    }

    stop()
    const emit = (channel, payload) => ctx.send(channel, { runId, ...payload })

    const run = runClaude({
      executable,
      extraArgs,
      prompt: text,
      sessionId: sessions.get(key),
      cwd: root,
      onStatus: (line) => emit('status', { text: line }),
      onSession: (id) => {
        // Not once the session has been cleared: a run cancelled by that still
        // reports on its way out, and would bring the old session back.
        if (run.cleared || !SESSION_ID.test(id) || sessions.get(key) === id) return
        sessions.set(key, id)
        saveSessions()
      }
    })
    current = run
    run.result
      .then(
        (answer) =>
          emit('done', { ...answer, sessionId: sessions.get(key) ?? null, compacts: !opencode }),
        (err) => emit('error', { message: err.message })
      )
      .finally(() => {
        if (current === run) current = null
      })
  })

  ctx.handle('cancel', stop)

  ctx.handle('session', () => ({ sessionId: sessions.get(sessionKey(ctx.getRepo().root)) ?? null }))

  ctx.handle('newSession', () => {
    if (current) current.cleared = true
    stop()
    sessions.delete(sessionKey(ctx.getRepo().root))
    saveSessions()
  })

  ctx.on('quit', stop)
}
