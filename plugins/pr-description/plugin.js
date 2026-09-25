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
        'The command that runs Claude Code, e.g. claude or claudebox. Run through a login ' +
        'shell, so anything on PATH in a terminal works.'
    },
    {
      key: 'extraArgs',
      label: 'Extra arguments',
      type: 'string',
      default: '--allowedTools "Bash(git:*)" Read Grep Glob',
      description:
        'Appended after "-p <prompt> --output-format stream-json --verbose", which the plugin ' +
        'always passes. Parsed by the shell, so quote as you would in a terminal. Without ' +
        'permission to run git, Claude cannot see the branch.'
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
