# Engineering Playbook

Reusable instructions for building software with AI: simplify first, find the root cause, challenge every addition, keep ownership clear, and verify useful progress.

[`AGENTS.md`](AGENTS.md) is the complete, self-contained instruction file. It combines engineering reasoning with project setup, verification, and delivery practices. Adapt it to the project's needs; it requires no particular framework or folder layout.

The maintained source is [alizss/engineering-playbook](https://github.com/alizss/engineering-playbook). Access requires permission while the repository is private.

## Get a local copy

With GitHub CLI authenticated:

```sh
gh repo clone aliok zss/engineering-playbook
```

You can also download the files through GitHub. Choose a tagged version when you want a fixed baseline.

## Use in one project

Copy this folder's `AGENTS.md` into the project's root as `AGENTS.md`. If the project already has that file, merge the relevant guidance and preserve its local instructions instead of overwriting it.

Add actual project commands, constraints, and important ownership boundaries as they become known. Do not create empty architectural folders or install tools solely because the instructions mention them.

Start a new agent session in that project. Ask it to identify the instructions it loaded and the verification commands it found.

## Use across all your Codex projects

Merge the contents of this folder's `AGENTS.md` into the `AGENTS.md` in your Codex home directory (normally `~/.codex/AGENTS.md`). Preserve existing personal instructions. If `CODEX_HOME` is customized, use that directory instead.

A global `AGENTS.override.md`, when present, takes precedence over the global `AGENTS.md`. Project instructions add local context and may override global defaults. Start a new session after setup and verify which sources were loaded.

Once installed globally, keep each project's instructions focused on local details rather than duplicating these defaults. Choose one maintained location for your personal defaults so copies do not silently drift.

Cloning this repository does not install instructions globally or update any project's existing instructions.

## Prompt for a new project

After copying or loading the instructions, use:

```text
Read AGENTS.md and use it throughout this project.

I want to build: [product and its users].
The first working outcome is: [one concrete user journey or output].
Constraints: [stack preferences, integrations, limits, and existing work].

Inspect what exists. Set up the smallest suitable structure and repeatable
run and verification commands. Implement the first working outcome, verify
it with evidence, and document how to run it. Reuse existing tools and
challenge every proposed component. Add structure only when needed.
```

## Markdown or skill?

Use these instructions as persistent working defaults. A skill is useful later for a specific repeatable procedure, such as reproducing a bug in a particular application with established commands and fixtures. Avoid duplicating this entire rulebook in a skill.

For another coding tool, load this file explicitly or use that tool's supported instruction-file mechanism; do not assume every tool automatically reads `AGENTS.md`.

## Improve the playbook

- Propose a change when a recurring failure or a tested workflow provides evidence for it.
- Prefer simplifying or replacing guidance over appending another rule. Keep one instruction per idea.
- Keep project-specific commands, architecture, and requirements in their own repositories.
- Try meaningful changes on real tasks and describe what improved, what regressed, and what remains uncertain.
- Use small commits or pull requests with the reason for the change and its validation.
- Review the Markdown, check links, and run `git diff --check` for documentation edits. This repository has no application build or test suite.
- Tag useful checkpoints. `v0.1.0` is the initial baseline, not a claim that these instructions have been validated for every project.
- Add a skill or script only when a repeated procedure has demonstrated the need.

## Adopt updates deliberately

In a clean checkout, use `git pull --ff-only` to fetch the latest default branch. Review changes since the version you adopted before merging them into your global or project instructions.

Record the adopted tag or commit in the destination. Preserve local requirements and do not overwrite existing instructions blindly. Copies do not update automatically.

Official reference: [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
