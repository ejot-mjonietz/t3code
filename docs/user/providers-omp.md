# Oh My Pi (omp)

T3 Code runs [Oh My Pi](https://omp.sh) (`omp`) natively, through its RPC mode. omp keeps its own
models, logins, model roles, extensions, skills, rules and session history, and T3 Code shows its
subagents, approvals and questions in the usual thread UI. When omp is installed and signed in,
new threads start on it.

## Set Up omp

1. Install omp on the machine running the T3 Code server:

   ```sh
   bun install -g @oh-my-pi/pi-coding-agent
   ```

2. Run `omp` in a terminal, then `/login` to connect a model provider, or configure an API key.
3. Open **Settings → Providers** and refresh Oh My Pi if it does not show as ready.

If `omp` is not on the server's `PATH`, set its **Binary path**. Launch arguments pass extra omp
flags such as `--profile` or `--no-lsp`. T3 Code rejects flags that change omp's mode, pick a
session, or change its approval mode, because T3 Code owns those.

## Models and Model Roles

The model picker lists the models omp reports for your signed-in providers, with the thinking
levels each model accepts. **Auto** lets omp choose a level for each prompt.

**omp default** runs omp's `default` model role. The picker also lists omp's **Fast** (`smol`),
**Thinking** (`slow`) and **Architect** (`plan`) roles when they are configured, so a thread can
follow a role and pick up changes to it.

Each Oh My Pi provider instance can set omp's model roles: default, fast, thinking, architect,
subagent (`task`) and commit. Use omp's `provider/model` form, optionally with a thinking level,
for example `github-copilot/gpt-6-luna:low`. Leave a field empty to keep omp's own setting.

- With **Save model roles to omp config** on, a changed role is written to omp's `config.yml`, so
  the `omp` CLI uses it too. Roles you later change in omp stay as they are until you change that
  field in T3 Code again.
- With it off, the roles apply only to sessions T3 Code starts.

Unless you pick another text generation model, commit messages and thread titles use the fast
role.

## Subagents

When omp's `task` tool starts subagents, each one appears as a subagent card with its task, model,
current step and final answer. Open a card, or the subagent's row in the thread's agents list, to
watch the subagent's own conversation: its task, streamed replies, reasoning and tool calls, live.
A subagent that starts its own subagents lists them in its conversation the same way. Subagent
conversations are read-only.

Subagents that keep running after omp ends its turn keep the thread waiting; when they finish, omp
continues the thread with their results. **Stop** on a subagent card cancels that subagent.

## Permission Modes

T3 Code applies the composer permission mode through omp's own approval modes:

- **Supervised** (`always-ask`) asks before tools that write files or run commands.
- **Auto-accept edits** (`write`) lets file edits through and asks before commands.
- **Full access** (`yolo`) runs tools without asking. omp still asks for restricted folders and
  provider safety checks.

**Approve for this session** uses omp's own session grant. The **Auto** option is not offered.
Changing the mode restarts the omp session and resumes the same conversation.

## Questions, Commands and Skills

When omp's `ask` tool asks you something, its form appears in the composer: each field becomes a
question with its choices, checkboxes allow several answers, and text fields take your typed
answer. omp's recommended or default choices start selected, so submitting without changes sends
them. Where omp offers **Other**, type your own answer. If omp's ask timeout runs out first, omp
uses its defaults.

omp's slash commands and skills appear in the composer menus. Commands that would move omp to
another session, model, title or folder are left out, because T3 Code manages those.

## Magic Keywords

omp acts on a few standalone words in a prompt: `ultrathink`, `chillax`, `orchestrate`,
`workflowz` and `jevify`. Each one adds omp's own instructions to that turn. The composer paints
them with omp's gradient while you type, and sent messages keep it, so you can see which words omp
will act on. Words inside code, file names and paths are not keywords. Keywords you turn off in
omp's settings (`magicKeywords`) are not painted.

## Todo Lists and Notices

omp's `todo` list shows as the thread's task list, phase by phase, and updates as omp works,
including inside subagent threads. When omp falls back to another model after errors or injects one
of your rules into the conversation, a notice in the thread says so.

## T3 Code Tools

T3 Code's tools, such as `delegate_task` and the browser preview tools, are available to omp.
omp loads most of them on demand.

## Troubleshooting

- **omp is not installed**: install it as above or set its binary path.
- **No usable models**: run `omp`, then `/login`, and refresh the provider.
- **A slow status check**: set `T3CODE_OMP_PROBE_TIMEOUT_MS` in the server's environment.

T3 Code can also run omp as a generic [ACP agent](./providers-acp.md) with `omp acp`, but that
route cannot show subagents.
