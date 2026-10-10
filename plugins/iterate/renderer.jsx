import React, { useCallback, useEffect, useRef, useState } from 'react'
import './style.css'

// An IPC rejection arrives as "Error invoking remote method 'x': Error: ...".
function message(error) {
  const text = error?.message || String(error)
  const match = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/.exec(text)
  return match ? match[1] : text
}

let runCounter = 0

// What happens to a finding once it has been decided on.
const ACTIONS = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'recommended', label: 'Fix (recommended)' },
  { value: 'custom', label: 'Fix (custom)' }
]

// Every top-level {...} in the text that parses as JSON, in order — for an
// answer that wrapped its findings in a list, a code fence, or spread each one
// over several lines instead of the one asked for.
function scanObjects(text) {
  const found = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = depth > 0
    } else if (char === '{') {
      if (depth++ === 0) start = index
    } else if (char === '}' && depth > 0 && --depth === 0) {
      try {
        found.push(JSON.parse(text.slice(start, index + 1)))
      } catch {
        // Braces in prose, not an object.
      }
    }
  }
  return found
}

// The findings in a review answer. One JSON object per line is what the prompt
// asks for; the whole text is scanned as well, for an answer that spread some
// of them over several lines, and whichever reading finds more wins — the scan
// can be thrown by a stray brace in prose, the line reading can't. Only
// objects with a title or a description count, so prose that happens to
// contain JSON of some other shape is not mistaken for a finding.
function parseFindings(text) {
  const perLine = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line.startsWith('{')) continue
    try {
      perLine.push(JSON.parse(line))
    } catch {
      // Not a whole object on one line; the scan may still find it.
    }
  }
  const isFinding = (value) => value && typeof value === 'object' && (value.title || value.desc)
  const byLine = perLine.filter(isFinding)
  const scanned = scanObjects(text).filter(isFinding)
  return (scanned.length > byLine.length ? scanned : byLine).map((value, index) => {
    const { id, title, desc, ...rest } = value
    return {
      id: id == null || id === '' ? String(index) : String(id),
      title: String(title ?? ''),
      desc: String(desc ?? ''),
      // Whatever else Claude put in — a severity, a file, a suggested fix —
      // shown as it is rather than lost.
      extra: Object.entries(rest).map(([key, extraValue]) => [
        key,
        typeof extraValue === 'string' ? extraValue : JSON.stringify(extraValue)
      ]),
      action: null,
      custom: ''
    }
  })
}

// The decisions made in the panel, as the prompt that applies them. Each
// finding is named by its title as well as its id: ids start again from 0 in
// every review, and the session holds them all.
function fixPrompt(findings) {
  const lines = findings.map((finding) => {
    const name = `finding ${finding.id} ("${finding.title}")`
    switch (finding.action) {
      case 'ignore':
        return `- please ignore ${name}.`
      case 'recommended':
        return `- please fix ${name} with the recommended solution.`
      default:
        return `- please fix ${name} with this solution: ${finding.custom.trim()}`
    }
  })
  return (
    'For the findings of your last review:\n' +
    `${lines.join('\n')}\n\n` +
    'When you are done, summarize what you changed.'
  )
}

function decided(finding) {
  return finding.action && (finding.action !== 'custom' || finding.custom.trim())
}

// Everything the panel knows about one repository. Kept per repository, since
// the session is: switching away and back again picks up where it was.
function initialState() {
  return {
    // idle     nothing to show yet — start a review
    // triage   findings to decide on
    // fixed    Claude has applied the decisions; its answer is shown
    step: 'idle',
    iteration: 0,
    // The review or fix under way: { runId, kind, log, startedAt }, or null.
    run: null,
    findings: [],
    reviewText: '',
    reviewSummary: '',
    fixPrompt: '',
    fixText: '',
    fixSummary: '',
    error: null,
    // The /compact that follows a fix: { runId, status: 'running' | 'done' |
    // 'error', log, error }, or null.
    compact: null,
    hasSession: false
  }
}

function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="itr-elapsed">{Math.max(0, Math.round((now - since) / 1000))}s</span>
}

function Log({ lines }) {
  const ref = useRef(null)
  // Pinned to the bottom, like a terminal, so the latest step is the one seen.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  if (lines.length === 0) return <div className="itr-log itr-log-empty">Waiting for Claude…</div>
  return (
    <ol ref={ref} className="itr-log">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ol>
  )
}

function Finding({ finding, index, onChange }) {
  return (
    <li className={`itr-finding ${decided(finding) ? 'decided' : ''}`}>
      <div className="itr-finding-title">
        <span className="itr-finding-id">#{finding.id}</span> {finding.title || '(untitled)'}
      </div>
      {finding.desc && <div className="itr-finding-desc">{finding.desc}</div>}
      {finding.extra.map(([key, value]) => (
        <div key={key} className="itr-finding-desc">
          <span className="itr-finding-key">{key}:</span> {value}
        </div>
      ))}
      <div className="itr-choices" role="radiogroup" aria-label={`What to do with finding ${finding.id}`}>
        {ACTIONS.map(({ value, label }) => (
          <button
            key={value}
            role="radio"
            aria-checked={finding.action === value}
            className={`itr-choice ${finding.action === value ? 'selected' : ''} ${value}`}
            onClick={() => onChange(index, { action: value })}
          >
            {label}
          </button>
        ))}
      </div>
      {finding.action === 'custom' && (
        <textarea
          className="itr-custom"
          value={finding.custom}
          placeholder="How Claude should fix it…"
          rows={3}
          onChange={(event) => onChange(index, { custom: event.target.value })}
          autoFocus
        />
      )}
    </li>
  )
}

function Iterate({ host, repo }) {
  const { ConfirmDialog, CommandOutput } = host.ui
  // root → state; see initialState()
  const [states, setStates] = useState(() => new Map())
  const [confirmingNewSession, setConfirmingNewSession] = useState(false)
  // runId → { key, kind }: the repository a run was for, so every event
  // reaches it, and what the run was, so its end can be followed up.
  const runs = useRef(new Map())

  const root = repo.root
  const state = (root && states.get(root)) || initialState()

  const update = useCallback((key, fn) => {
    setStates((prev) => {
      const next = new Map(prev)
      next.set(key, fn(prev.get(key) ?? initialState()))
      return next
    })
  }, [])

  const updateRun = useCallback(
    (runId, fn) => {
      const run = runs.current.get(runId)
      if (run) update(run.key, fn)
    },
    [update]
  )

  // Whether there is a session to continue, as the main process sees it.
  useEffect(() => {
    if (!root) return
    host
      .invoke('session')
      .then(({ sessionId }) => update(root, (current) => ({ ...current, hasSession: Boolean(sessionId) })))
      .catch(() => {})
  }, [host, root, update])

  // A run that ended, one way or the other. Its log goes with the answer, for
  // anyone who wants to see how Claude got there.
  const settle = useCallback(
    (runId, outcome) =>
      updateRun(runId, (current) => {
        if (current.compact?.runId === runId) {
          return {
            ...current,
            compact: outcome.error
              ? { ...current.compact, status: 'error', error: outcome.error }
              : { ...current.compact, status: 'done' },
            hasSession: outcome.sessionId !== undefined ? Boolean(outcome.sessionId) : current.hasSession
          }
        }
        if (current.run?.runId !== runId) return current
        const { kind, log } = current.run
        const base = {
          ...current,
          run: null,
          lastLog: log.join('\n'),
          hasSession: outcome.sessionId !== undefined ? Boolean(outcome.sessionId) : current.hasSession
        }
        // Failing leaves the panel where it was, with the reason on top:
        // findings keep their decisions, a fix answer stays up.
        if (outcome.error) return { ...base, error: outcome.error }
        if (kind === 'review') {
          return {
            ...base,
            step: 'triage',
            iteration: current.iteration + 1,
            findings: parseFindings(outcome.text),
            reviewText: outcome.text,
            reviewSummary: outcome.summary
          }
        }
        return { ...base, step: 'fixed', fixText: outcome.text, fixSummary: outcome.summary }
      }),
    [updateRun]
  )

  const startRun = useCallback(
    async (key, kind, prompt) => {
      const runId = `${Date.now()}-${++runCounter}`
      runs.current.set(runId, { key, kind })
      if (kind === 'compact') {
        update(key, (current) => ({ ...current, compact: { runId, status: 'running', log: [], error: null } }))
      } else {
        update(key, (current) => ({
          ...current,
          run: { runId, kind, log: [], startedAt: Date.now() },
          error: null,
          compact: null,
          ...(kind === 'fix' ? { fixPrompt: prompt } : {})
        }))
      }
      try {
        await host.invoke('run', runId, kind, prompt)
      } catch (err) {
        // Refused before it started: nothing will arrive for this run.
        settle(runId, { error: message(err) })
        runs.current.delete(runId)
      }
    },
    [host, update, settle]
  )

  useEffect(() => {
    const unsubscribe = [
      host.subscribe('status', ({ runId, text }) =>
        updateRun(runId, (current) => {
          if (current.run?.runId === runId) {
            return { ...current, run: { ...current.run, log: [...current.run.log, text] } }
          }
          if (current.compact?.runId === runId) {
            return { ...current, compact: { ...current.compact, log: [...current.compact.log, text] } }
          }
          return current
        })
      ),
      host.subscribe('done', ({ runId, text, summary, sessionId, compacts }) => {
        settle(runId, { text, summary, sessionId })
        const run = runs.current.get(runId)
        runs.current.delete(runId)
        if (run?.kind === 'fix') {
          // Claude has changed files: the list should show them now, not at
          // the next window focus. Then the session is compacted, so round
          // after round of reviews doesn't run it out of context — unless the
          // agent compacts by itself, which opencode does.
          host.refreshRepo()
          if (compacts) startRun(run.key, 'compact')
        }
      }),
      host.subscribe('error', ({ runId, message: error }) => {
        settle(runId, { error })
        const run = runs.current.get(runId)
        runs.current.delete(runId)
        if (run?.kind === 'fix') {
          // A fix that failed part-way may still have changed files.
          host.refreshRepo()
        }
      })
    ]
    return () => unsubscribe.forEach((fn) => fn())
  }, [host, updateRun, settle, startRun])

  if (!root) {
    return <div className="itr-panel itr-empty">Open a repository to start.</div>
  }

  const running = Boolean(state.run)
  const compacting = state.compact?.status === 'running'
  const busy = running || compacting

  const review = () => startRun(root, 'review')

  const applyFixes = () => startRun(root, 'fix', fixPrompt(state.findings))

  const changeFinding = (index, change) =>
    update(root, (current) => ({
      ...current,
      findings: current.findings.map((finding, at) => (at === index ? { ...finding, ...change } : finding))
    }))

  const decideAll = (action) =>
    update(root, (current) => ({
      ...current,
      findings: current.findings.map((finding) => (finding.action ? finding : { ...finding, action }))
    }))

  const newSession = async () => {
    setConfirmingNewSession(false)
    try {
      await host.invoke('newSession')
      update(root, () => initialState())
    } catch (err) {
      update(root, (current) => ({ ...current, error: message(err) }))
    }
  }

  const allDecided = state.findings.length > 0 && state.findings.every(decided)
  const undecided = state.findings.filter((finding) => !finding.action).length

  return (
    <div className="itr-panel">
      <div className="itr-toolbar">
        <span className="itr-session">
          {state.hasSession ? 'Continuing session' : 'New session'}
          {state.iteration > 0 && ` · iteration ${state.iteration}`}
          {repo.branch && <span className="itr-branch"> · {repo.branch}</span>}
        </span>
        <button
          className="button itr-small"
          onClick={() => setConfirmingNewSession(true)}
          disabled={!state.hasSession && state.step === 'idle' && !busy}
          title="Forget the conversation so far and start the next review in a new Claude session (what /clear does)"
        >
          New session
        </button>
      </div>

      <div className="itr-content">
        {state.error && (
          <p className="itr-error" role="alert">
            {state.error}
          </p>
        )}

        {running ? (
          <>
            <p className="itr-running">
              <span className="itr-spinner" />
              {state.run.kind === 'review' ? 'Claude is reviewing the branch…' : 'Claude is applying the fixes…'}{' '}
              <Elapsed since={state.run.startedAt} />
            </p>
            <Log lines={state.run.log} />
          </>
        ) : state.step === 'triage' ? (
          <>
            <h3 className="itr-heading">
              {state.findings.length === 0
                ? 'No findings'
                : `${state.findings.length} finding${state.findings.length === 1 ? '' : 's'}`}
              {state.reviewSummary && <span className="itr-summary">{state.reviewSummary}</span>}
            </h3>
            {state.findings.length === 0 ? (
              <>
                <p className="itr-note">
                  Nothing in Claude&apos;s answer read as a finding. If it did report some, the prompt
                  may not be asking for one JSON object per finding. The answer:
                </p>
                <pre className="itr-output">{state.reviewText || '(empty)'}</pre>
              </>
            ) : (
              <>
                {undecided > 0 && (
                  <div className="itr-bulk">
                    Mark the {undecided} undecided:
                    <button className="button itr-small" onClick={() => decideAll('recommended')}>
                      Fix (recommended)
                    </button>
                    <button className="button itr-small" onClick={() => decideAll('ignore')}>
                      Ignore
                    </button>
                  </div>
                )}
                <ol className="itr-findings">
                  {state.findings.map((finding, index) => (
                    <Finding key={index} finding={finding} index={index} onChange={changeFinding} />
                  ))}
                </ol>
                <CommandOutput key={`review-${state.iteration}`} output={state.reviewText} label="Claude's answer" />
              </>
            )}
          </>
        ) : state.step === 'fixed' ? (
          <>
            <h3 className="itr-heading">
              Fixes applied
              {state.fixSummary && <span className="itr-summary">{state.fixSummary}</span>}
            </h3>
            <pre className="itr-output">{state.fixText || '(Claude gave no summary.)'}</pre>
            <CommandOutput key={`prompt-${state.iteration}`} output={state.fixPrompt} label="Prompt sent" />
          </>
        ) : (
          <p className="itr-note">
            Start a review and Claude will look over the changes on this branch. Each finding can then
            be ignored or fixed, and the fixes are sent back in the same session — so the next review
            knows what has already been reported.
          </p>
        )}

        {!running && state.lastLog && (
          <CommandOutput key={`log-${state.iteration}-${state.step}`} output={state.lastLog} label="Session log" />
        )}

        {state.compact && (
          <div className={`itr-compact ${state.compact.status}`}>
            {state.compact.status === 'running' && (
              <>
                <span className="itr-spinner" /> Compacting the session…
              </>
            )}
            {state.compact.status === 'done' && 'Session compacted.'}
            {state.compact.status === 'error' &&
              `Could not compact the session: ${state.compact.error} The session carries on uncompacted.`}
          </div>
        )}
      </div>

      <div className="itr-actions">
        {running ? (
          <button className="button" onClick={() => host.invoke('cancel')}>
            Cancel
          </button>
        ) : state.step === 'triage' && state.findings.length > 0 ? (
          <>
            <button className="button" onClick={review} disabled={busy} title="Skip these and review again">
              Review again
            </button>
            <span className="itr-spacer" />
            <button
              className="button primary"
              onClick={applyFixes}
              disabled={!allDecided || busy}
              title={allDecided ? 'Send these decisions to Claude' : 'Decide on every finding first'}
            >
              Send to Claude
            </button>
          </>
        ) : (
          <>
            <span className="itr-spacer" />
            <button
              className="button primary"
              onClick={review}
              disabled={busy}
              title={compacting ? 'Waiting for the session to finish compacting' : undefined}
            >
              {state.iteration === 0 ? 'Start review' : 'Start next review'}
            </button>
          </>
        )}
      </div>

      {confirmingNewSession && (
        <ConfirmDialog
          title="Start a new session?"
          message={
            'Claude forgets the reviews and fixes so far, so findings already reported may be ' +
            'reported again.' +
            (busy ? ' The run under way is cancelled.' : '')
          }
          confirmLabel="New session"
          onCancel={() => setConfirmingNewSession(false)}
          onConfirm={newSession}
        />
      )}
    </div>
  )
}

export default function setup(host) {
  host.addCommand({
    id: 'toggle',
    label: 'Iterate',
    title: 'Review and fix this branch with Claude, a round at a time',
    shortcut: 'Ctrl+Shift+E',
    run: () => host.togglePanel()
  })
  host.addPanel(
    function IteratePanel(props) {
      return <Iterate host={host} {...props} />
    },
    { title: 'Iterate' }
  )
}
