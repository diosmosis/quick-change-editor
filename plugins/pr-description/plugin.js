// Read by both halves of the plugin: main.js for the values, the settings
// dialog for how to draw them.

// What Claude is asked when no prompt of your own is set.
export const DEFAULT_PROMPT =
  'please create a one line summary for and a list of changes introduced for the current branch'

export default {
  id: 'pr-description',
  name: 'PR description',
  description:
    'Asks Claude Code for a pull request title and description for the current branch, ' +
    'to edit and copy. Nothing is sent to GitHub.',
  settings: [
    {
      key: 'executable',
      label: 'Claude executable',
      type: 'string',
      default: 'claude',
      description:
        'The command that runs Claude Code, e.g. claude or claudebox — or opencode, e.g. ' +
        'opencode or claudebox opencode. Run through a login shell, so anything on PATH in a ' +
        'terminal works, and parsed by it, so quote a path with spaces in it.'
    },
    {
      key: 'allowedTools',
      label: 'Allowed tools',
      type: 'string',
      default: '"Bash(git:*)" Read Grep Glob',
      description:
        'Passed as --allowedTools. Parsed by the shell, so quote as you would in a terminal. ' +
        'Without permission to run git, Claude cannot see the branch. Not used with claudebox, ' +
        'which runs without restrictions since it is already in a container, nor with ' +
        'opencode, which takes its permissions from its own config.'
    },
    {
      key: 'extraArgs',
      label: 'Extra arguments',
      type: 'string',
      default: '',
      description:
        'Appended after "-p <prompt> --output-format stream-json --verbose" and the allowed ' +
        'tools, which the plugin always passes (for opencode, "run --format json"). Parsed by ' +
        'the shell, so quote as you would in a terminal.'
    },
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'text',
      rows: 3,
      // Empty rather than the default itself, so the default can change with
      // the app without being frozen into anyone's settings file.
      default: '',
      placeholder: DEFAULT_PROMPT,
      description: 'Leave empty to use the default, shown greyed out above.'
    }
  ]
}
