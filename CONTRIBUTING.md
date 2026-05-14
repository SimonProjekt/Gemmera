# Contributing to Gemmera

This document describes how we work together in the Gemmera repo. Read it before opening your first PR. It is also intended to be saved as Claude memory so that AI pair-programmers follow the same rules as the team.

## TL;DR

- Always branch off `dev` using a `feature/`, `fix/`, `docs/`, or `refactor/` prefix
- Write commits in [Conventional Commits](https://www.conventionalcommits.org/) format
- Open PRs against `dev`, **not** `main`
- At least one teammate must approve before merge
- Never commit directly to `main` or `dev`
- Never `git push --force` to `main` or `dev`
- All repo and GitHub content (code, docs, commits, branches, PRs, issues) is in **English**

## Branch strategy

| Branch | Purpose | Who pushes there? |
|---|---|---|
| `main` | Stable, demo-ready code. Updated only via PR from `dev` at milestones/releases. | Nobody directly — only via PR. |
| `dev` | Integration branch. All feature work converges here. | Nobody directly — only via PR from feature branches. |
| `feature/<name>` | All new work. Branched from `dev`, merged back into `dev`. | The author. |

### Naming convention for feature branches

- `feature/<descriptive-name>` — new functionality (e.g. `feature/state-machine-framework`)
- `fix/<descriptive-name>` — bug fix
- `docs/<descriptive-name>` — documentation change
- `refactor/<descriptive-name>` — refactor with no behavior change

Use short English descriptions with hyphens — that matches the branch names GitHub displays in its UI.

## Daily workflow

### 1. Before starting a new task

```bash
git fetch
git checkout dev
git pull
git checkout -b feature/<your-feature>
```

### 2. While working

```bash
git status                                    # what changed?
git diff                                      # show the changes
git add <file>                                # stage specific files (avoid git add .)
git commit -m "feat(area): short description"
git push -u origin feature/<your-feature>    # first push
git push                                      # subsequent pushes
```

Commit often in small chunks. Each commit should be one logical change.

### 3. Before opening a PR — sync with `dev`

Other teammates have likely merged work into `dev` while you were busy. Pull it in:

```bash
git fetch
git merge origin/dev
# if conflicts: resolve them (see section below), commit, push
```

This catches conflicts on your branch instead of mixing them into the PR.

### 4. Open the PR

```bash
gh pr create --title "feat(area): short title" --body "..."
```

The repo's default branch is `dev`, so PRs target `dev` automatically. Pass `--base dev` explicitly if you want to be defensive, or `--base main` only when preparing a release PR from `dev` to `main`.

## Commit messages — Conventional Commits

Format: `<type>(<scope>): <short description>`

| Type | When to use it |
|---|---|
| `feat` | New functionality |
| `fix` | Bug fix |
| `docs` | Documentation-only change |
| `refactor` | Code improvement without behavior change |
| `test` | Added or modified tests |
| `chore` | Build, package, config, etc. |

**Scope:** the area being changed — `rag`, `ui`, `tool-loop`, `runtime`, `classifier`, `chat`, etc.

**Examples from the repo history:**

- `feat(rag): markdown-aware chunker (closes #6)`
- `fix(rag): chunker hashes textForEmbed, not raw text`
- `docs: add bge-m3 install step and mark Vecka 3 complete`

**Auto-close issues:** add `Closes #N` (or `Fixes #N` for bugs) in the commit message or PR body — the issue closes automatically when the PR is merged.

## Issues

We use GitHub Issues for all task tracking. [Open issues](https://github.com/SimonProjekt/Gemmera/issues) is the list of what needs to be done.

### When you take an issue

1. Read the full issue description
2. Leave a comment on the issue: e.g. "I'll take this"
3. Assign yourself: `gh issue edit <N> --add-assignee @me`
4. Reference the issue in your branch and commits (`feature/state-machine-framework` for #33)
5. Close the issue via your PR with `Closes #<N>`

### Before claiming a large issue

Check that nobody else is already working in that area. Quick check:

```bash
git log --all --oneline -20 --grep="<keyword>"
gh issue list --assignee "*"
```

## Pull Requests

### One PR = one logical reviewable unit, not necessarily one issue

Group closely related issues into the same branch and PR when natural. Aim for PRs that can be reviewed in ~30 minutes (~500 lines of diff is a good rule of thumb). Split if a branch gets large or starts mixing different areas.

### What a PR should contain

The PR description should cover:

- **What** — short summary of the change
- **Why** — link to the issue and brief motivation
- **How to test** — commands or manual steps so the reviewer can verify

Template:

```markdown
## What
Implements the state machine framework per #33.

## Why
Closest building block for the ingest and query state machines (#39, #41), which are
the next priority in Tool-loop v1.

## How to test
- `npm test` — all new unit tests should pass
- Add a debug state and verify transitions in the dev tools

Closes #33
```

### Review process

- At least one teammate must approve before merge
- The reviewer role rotates between team members
- Use GitHub's review buttons: **Approve**, **Request changes**, **Comment**
- Discuss in PR comments (not in DM/Slack) — this gives traceability
- Aim to review within 24 hours

### Merge policy

- **Squash & merge** is the default — one commit per feature in the `dev` history
- **The PR author merges** after approval, not the reviewer
- Delete the feature branch after merge (GitHub provides a button)

## Conflicts

When `git merge origin/dev` reports conflicts:

1. `git status` lists the conflicted files
2. Open each file — look for the markers:
   ```
   <<<<<<< HEAD
   your change
   =======
   their change
   >>>>>>> origin/dev
   ```
3. Keep what should remain (could be both, one, or a combination), remove all markers
4. `git add <file>` once the file is fixed
5. When all files are resolved: `git commit` (Git suggests a merge message automatically)
6. Run the tests to verify nothing broke
7. `git push`

If you get stuck, ask in the team chat or ping a teammate on the issue.

## Releases (dev → main)

When `dev` is stable and contains a milestone:

1. Open a PR from `dev` → `main`
2. The whole team reviews
3. Merge → tag (`git tag v0.1.0`) → create a release on GitHub

## Things we never do

- **Never** commit directly to `main` or `dev`
- **Never** `git push --force` to `main` or `dev`
- **Never** merge your own PR without review
- **Never** commit secrets (`.env`, API keys, passwords)
- **Never** delete other teammates' branches without asking
- **Never** use `--no-verify` to bypass hooks

## For Claude (AI pair)

If you read this as Claude when working in the Gemmera repo, follow these rules:

- All content you write to the repo or to GitHub is in English — code, comments, commit messages, branch names, PR titles, PR descriptions, issue comments. The user may chat with you in Swedish, but anything persisted to GitHub is English
- Always create a `feature/`, `fix/`, `docs/`, or `refactor/` branch from `dev` before making changes — never commit directly to `main` or `dev`
- Use Conventional Commits format for every commit message (`<type>(<scope>): <description>`)
- The PR base must always be `dev`, never `main`
- Before starting work on an issue, ask the user to confirm it should be claimed and propose self-assigning on GitHub
- Suggest the PR title and body, but do not open the PR without the user's approval
- Force-push, `git reset --hard`, branch deletion, and other destructive operations require explicit user approval — ask first
- Before suggesting a large branch operation (rebase, force-push), check that the branch is not shared
