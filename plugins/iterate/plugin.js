// Read by both halves of the plugin: main.js for the values, the settings
// dialog for how to draw them.

// What Claude is asked to review with when no prompt of your own is set. The
// panel reads findings out of the answer one JSON object per line, so a prompt
// of your own has to keep asking for that shape.
export const DEFAULT_REVIEW_PROMPT =
  'please review the changes in the current branch for correctness and security. please do not ' +
  'repeat any findings that have been previously reported, and output each finding in a json ' +
  'list (ie, jsonl format) in the following format: {"id": "0", "title": "...", "desc": "..."}'

export default {
  id: 'iterate',
  name: 'Iterate',
  description:
    'A panel for review/fix rounds with Claude Code on the current branch: Claude reviews, ' +
    'you decide what happens to each finding, Claude applies it — all in one session.',
  settings: [
    {
      key: 'executable',
      label: 'Claude executable',
      type: 'string',
      default: 'claude',
      description:
        'The command that runs Claude Code, e.g. claude or claudebox. Run through a login ' +
        'shell, so anything on PATH in a terminal works.'
    },
    {
      key: 'extraArgs',
      label: 'Extra arguments',
      type: 'string',
      default: '--allowedTools "Bash(git:*)" Read Grep Glob',
      description:
        'Appended to every prompt, after "-p <prompt> --output-format stream-json --verbose" ' +
        'and the session flag, which the plugin always passes. Parsed by the shell, so quote ' +
        'as you would in a terminal. Without permission to run git, Claude cannot see the branch.'
    },
    {
      key: 'fixArgs',
      label: 'Extra arguments when fixing',
      type: 'string',
      default: '--permission-mode acceptEdits',
      description:
        'Added after the extra arguments above, only for the prompt that applies fixes — so ' +
        'the review itself cannot edit anything. Without permission to edit, Claude cannot fix.'
    },
    {
      key: 'prompt',
      label: 'Review prompt',
      type: 'text',
      rows: 4,
      // Empty rather than the default itself, so the default can change with
      // the app without being frozen into anyone's settings file.
      default: '',
      placeholder: DEFAULT_REVIEW_PROMPT,
      description:
        'Leave empty to use the default, shown greyed out above. Keep asking for one JSON ' +
        'object per finding, with "id", "title" and "desc": that is what the panel reads.'
    }
  ]
}
