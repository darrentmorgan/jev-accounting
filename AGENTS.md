# Project instructions

Keep this a small local prototype for classifying bank transactions with
`typesafe-ai/jev` through Vercel AI Gateway and the AI SDK evaluation API.

- Work on a feature branch. Keep authoring worktrees inside this repository.
- Never commit or print API keys, `.env`, real bank exports, or model request logs.
- Use synthetic examples unless the user supplies data for classification.
- Do not replace Jev with a text model or silently use mocked classification.
- Keep uncertain or failed results visibly Unassigned. Show selected-category
  probabilities as model estimates, never as measured accuracy.
- Keep the API key server-side and preserve the local-only server boundary.
- Run `npm run check`, `npm test`, and `npm run build` after code changes.
- Distinguish offline test success from authenticated Jev inference evidence.
- No deployment, accounting-system integration, or financial postings are part
  of the initial prototype.
