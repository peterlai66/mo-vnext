# MO vNext Agent Rules

## Project
- This project is MO vNext
- Stack: Cloudflare Workers + TypeScript + LINE Bot
- Main runtime is Cloudflare Worker, not Node.js server
- Keep implementation deployable to Cloudflare Workers

## Code rules
- Do not use `any` unless explicitly approved
- Do not use `globalThis as any`
- Use native Cloudflare Worker types: `Request`, `Response`, `fetch`, `URL`
- Do not rename existing env variables without approval
- Do not change webhook route without approval
- Do not add packages unless explicitly requested
- Do not create extra files unless explicitly requested

## Editing rules
- Modify only the files explicitly requested
- Preserve existing working behavior unless the task requires changing it
- Prefer minimal changes over broad rewrites
- Keep code simple and easy to review

## Command system rules
- Keep command handling easy to extend
- Existing commands must not break when adding new commands
- Non-command text should keep current expected behavior unless requested otherwise

## Git rules
- Use Conventional Commits
- Commit message type in English: feat, fix, refactor, chore
- Description and bullet points in Traditional Chinese
- Do not use `Body:`

## Response rules
- When suggesting code changes, prefer production-safe implementation
- When unsure, do not invent architecture; extend the current structure