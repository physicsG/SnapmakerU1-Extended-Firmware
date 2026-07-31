# GitHub Copilot Agent Rules — Issues & Pull Requests

These rules apply **only** when a GitHub Copilot coding agent is working on a
GitHub issue or pull request for this repository (i.e. tasks initiated from
github.com, not local editor sessions).

They supplement, and do not override, [copilot-instructions.md](copilot-instructions.md).

## Scope

- Triggered when Copilot is assigned an issue, asked to open a PR, or asked to
  fix/implement something via a GitHub comment.
- Does **not** apply to local IDE chat sessions.

## Visual Evidence Requirements

When the work touches anything observable (UI, web app, screen app, printer
display, generated docs, build output, runtime behavior, log output, etc.),
the agent **MUST** include visual evidence in the pull request.

### What to capture

- **New features**: screenshots or short screen recordings showing the feature
  in action. Include before/after when replacing existing behavior.
- **Bug fixes**: a screenshot reproducing the original bug (or a quote of the
  failing log/output) **and** a screenshot showing the fixed behavior.
- **UI / web app changes** (Fluidd, Mainsail, OpenRFID, camera app, remote
  screen, monitoring dashboards): screenshots of the affected views at
  desktop and, where relevant, mobile widths.
- **Printer screen / on-device UI changes**: a photo or screen capture of the
  printer display showing the change.
- **CLI / shell / build changes**: a fenced code block with the exact command
  invoked and its relevant output.
- **Documentation changes**: a screenshot of the rendered Markdown (GitHub
  preview is acceptable) for any non-trivial formatting change.
- **Test changes**: paste the relevant `pytest` (or other test runner) output
  showing the new/affected tests passing.

### Where to put the evidence

1. **Pull request description** — primary location. Use a dedicated
   `## Screenshots` or `## Visual evidence` section.
2. **PR comments** — when responding to review feedback that requested a
   change, attach an updated screenshot showing the result.
3. **Linked issue** — if the issue requested a visual outcome, post the
   final screenshot as a comment on the issue when the PR is opened.

### How to attach

- Drag-and-drop images into the GitHub PR/comment editor so GitHub hosts them
  on `user-images.githubusercontent.com` (or the new `github.com/user-attachments`
  CDN). **Never** commit large screenshots into the repository.
- For animations, prefer short `.gif` or `.mp4` (< 10 MB) uploaded the same way.
- Always include descriptive **alt text** for every image:
  `![Fluidd dashboard showing new RFID spool panel](url)`.
- Group multiple related shots under collapsible sections:
  ```markdown
  <details><summary>Before / after</summary>

  ![before](url1)
  ![after](url2)

  </details>
  ```

### When evidence cannot be produced

If the change genuinely produces no observable output (e.g. internal
refactor, comment-only change, dependency bump with no behavioral diff),
**explicitly state** this in the PR description under a
`## Visual evidence` heading, e.g.:

> No visual evidence: internal refactor of `scripts/helpers/pack_firmware.sh`
> with no behavioral change. Verified by `./dev.sh make test`.

Do **not** silently omit the section.

## PR Description Template

Every PR opened by the Copilot agent should follow this structure:

```markdown
## Summary
<what changed and why, linking the issue with `Fixes #123`>

## Changes
- <bullet list of concrete changes>

## Visual evidence
<screenshots / recordings / command output as described above,
 or an explicit "No visual evidence: <reason>" note>

## Validation
- <build/test commands run and their result>
```

## Validation Before Requesting Review

Before marking the PR ready for review or pinging a human:

- Run the relevant build/test target from [copilot-instructions.md](copilot-instructions.md)
  (typically `./dev.sh make test` and/or `./dev.sh make build PROFILE=...`).
- Paste the resulting summary line(s) into the **Validation** section.
- Confirm every required screenshot is actually rendered in the PR preview
  (broken image links are treated as missing evidence).

## Security

- **NEVER** include screenshots that contain secrets, API keys, printer
  serial numbers, IP addresses on private networks, SSH keys, or personal
  information. Crop or redact before uploading.
- **NEVER** attach firmware images, full log dumps, or other large binaries
  to the PR; link to CI artifacts instead.
