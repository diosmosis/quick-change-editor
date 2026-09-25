// Runs Claude Code headless in the open repository and streams what it is doing
// to the window. One run at a time: starting another stops the first.
//
// Events sent to the renderer, each tagged with the runId generate() was given:
//   status  { runId, text }                  a line of progress
//   done    { runId, text, summary }         the answer, and a one-line footer
//   error   { runId, message }               it failed, or was cancelled
import { spawn } from 'node:child_process'
import { DEFAULT_PROMPT } from './plugin.js'

// What an interactive bash with no terminal says before it does anything else.
const SHELL_NOISE = /^bash: (cannot set terminal process group\b.*|no job control in this shell)$/

// How much of stderr is kept for the error message when a run fails.
const MAX_STDERR_CHARS = 4000

function firstLine(text, max = 160) {
  const line = String(text).trim().split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// A tool call as one line: the tool, and the argument that says what it's for.
function describeToolUse({ name, input = {} }) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description
  return detail ? `${name}: ${firstLine(detail, 140)}` : name
}

// Turns one line of stream-json into progress, or the final answer. A line that
// isn't JSON is passed on as progress as it stands — a wrapper script may print
// its own, and it's better seen than dropped.
function interpret(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return { status: [line] }
  }
  switch (event.type) {
    case 'system':
      return event.subtype === 'init'
        ? { status: [`Session started${event.model ? ` (${event.model})` : ''}`] }
        : {}
    case 'assistant': {
      const status = []
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') status.push(describeToolUse(block))
        else if (block.type === 'text' && block.text.trim()) status.push(firstLine(block.text))
      }
      return { status }
    }
    case 'result':
      return { result: event }
    default:
      return {}
  }
}

function summarize(result) {
  const parts = []
  if (result.duration_ms) parts.push(`${Math.round(result.duration_ms / 1000)}s`)
  if (result.num_turns) parts.push(`${result.num_turns} turn${result.num_turns === 1 ? '' : 's'}`)
  if (typeof result.total_cost_usd === 'number') parts.push(`$${result.total_cost_usd.toFixed(2)}`)
  return parts.join(' · ')
}

export default function activate(ctx) {
  let current = null // { runId, child, cancelled }

  const stop = () => {
    if (!current) return
    current.cancelled = true
    current.child.kill('SIGTERM')
    current = null
  }

  // The renderer names the run, so that it knows which branch every event is
  // about before the first one can arrive.
  ctx.handle('generate', (runId) => {
    const { root } = ctx.getRepo()
    if (!root) throw new Error('No repository is open.')
    const { executable, extraArgs, prompt: customPrompt } = ctx.getSettings()
    const prompt = customPrompt.trim() || DEFAULT_PROMPT
    if (!executable.trim()) throw new Error('Set the Claude executable in Settings first.')

    stop()
    const emit = (channel, payload) => ctx.send(channel, { runId, ...payload })

    // Through a login shell for the same reason hooks are (see gitInShell in
    // src/main/git.js): from the desktop menu PATH has none of what ~/.bashrc
    // adds. The executable and prompt arrive as positional parameters, so only
    // the extra arguments — typed by the user to be shell words — are parsed.
    const script = `exec "$0" -p "$1" --output-format stream-json --verbose ${extraArgs}`
    const child = spawn('bash', ['-ilc', script, executable.trim(), prompt], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const run = { runId, child, cancelled: false }
    current = run

    let buffered = ''
    let result = null
    let rawOutput = ''
    let stderr = ''

    const onLine = (line) => {
      if (!line.trim() || SHELL_NOISE.test(line)) return
      const { status = [], result: final } = interpret(line)
      if (final) result = final
      else if (!line.startsWith('{')) rawOutput += `${line}\n`
      for (const text of status) emit('status', { text })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop()
      lines.forEach(onLine)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)
      for (const line of chunk.split('\n')) {
        if (line.trim() && !SHELL_NOISE.test(line)) emit('status', { text: line })
      }
    })

    let finished = false
    const finish = (channel, payload) => {
      if (finished) return
      finished = true
      if (current === run) current = null
      emit(channel, payload)
    }

    child.on('error', (err) =>
      finish('error', { message: `Could not start bash to run ${executable}: ${err.message}` })
    )
    child.on('close', (code) => {
      if (buffered) onLine(buffered)
      if (run.cancelled) return finish('error', { message: 'Cancelled.' })
      if (result && !result.is_error && typeof result.result === 'string') {
        return finish('done', { text: result.result.trim(), summary: summarize(result) })
      }
      if (result) {
        return finish('error', { message: result.result || `Claude stopped: ${result.subtype}` })
      }
      // No result event at all: an executable that doesn't speak stream-json.
      // If it succeeded, whatever it printed is the answer.
      if (code === 0 && rawOutput.trim()) {
        return finish('done', { text: rawOutput.trim(), summary: '' })
      }
      const said = stderr.split('\n').filter((line) => !SHELL_NOISE.test(line)).join('\n').trim()
      finish('error', { message: said || `${executable} exited with code ${code} and no answer.` })
    })
  })

  ctx.handle('cancel', stop)
  ctx.on('quit', stop)
}
