# Facilitator Guide

## Recommended Workshop Flow

1. Invite attendees to sign up for Statewright and open this folder locally if they can.
2. Tell everyone else to follow the live solve on the overhead screen.
3. Run `npm run demo`, create a named arena, and launch the war room.
4. Run tests so the room sees the red baseline.
5. Load or explain `workflows/xtern-sdlc.json`.
6. Ask the agent to read `spec.md`, make tests pass, then improve the Vue dashboard.
7. Pause at each Statewright transition and call out which tools are allowed.
8. Use `s` for the active build server or `v` for the completed reference build.

## Live Prompt

```text
Use Statewright.
First deactivate any active Statewright workflow.
Then activate the xtern-sdlc workflow. If xtern-sdlc is not available, create it from workflows/xtern-sdlc.json and load it.
After xtern-sdlc is active, read spec.md first.
Run npm test, explain the failures, then make the backend ETL match the spec.
After tests pass, improve the Vue dashboard without changing the API contract.
```

## Reference Solution

Use `npm run gold` if the live solve gets stuck or time runs short. It applies the reference ETL implementation from `versions/gold`.

In the demo TUI, press `v` to launch a completed reference dashboard on `0.0.0.0:4318`.

## What To Emphasize

- The agent should not edit before it understands the spec and tests.
- The tests are the acceptance contract.
- The Vue dashboard is intentionally simple; useful information beats decoration.
- The SDLC workflow is the product lesson, not just the finished app.

## Fallback

If attendee setup is uneven, keep the room interactive by asking them to predict:

- Which function is wrong?
- Which test should fail next?
- Which Statewright state should the agent be in?
- Which tool call should be blocked?
