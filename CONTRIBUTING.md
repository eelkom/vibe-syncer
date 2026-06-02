# Contributing Guide

## Branch Strategy

All branches are created from `main`.

| Branch | Purpose |
|--------|---------|
| `main` | Production deployment branch |
| `feat/#issue-number` | New feature development |
| `fix/#issue-number` | Bug fixes |
| `refactor/#issue-number` | Code refactoring |
| `chore/#issue-number` | Build, config, documentation |

```
main
 └─ feat/#12
 └─ fix/#15
 └─ chore/#18
```

---

## Commit Convention

```
[#issue-number]Type: description
```

| Type | Description |
|------|-------------|
| `Feat` | New feature |
| `Fix` | Bug fix |
| `Refactor` | Code refactoring |
| `Style` | Style / design changes |
| `Docs` | Documentation updates |
| `Chore` | Build or config changes |

**Examples**

```
[#12]Feat: Add post search feature
[#15]Fix: Fix image upload error
[#18]Refactor: Extract API call module
```

---

## PR & Merge Strategy

- One PR per issue.
- Use **Squash and Merge** to keep `main` history clean.
- PR title follows the commit convention format: `[#issue-number]Type: description`
- PR body follows the `.github/PULL_REQUEST_TEMPLATE.md` format.

---

## Issue Flow

1. Create an issue before starting any work.
2. Include the issue number in both the branch name and commit message.
3. Link the PR with `Closes #issue-number` to auto-close the issue on merge.
