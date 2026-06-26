# Xtern Workshop Postmortem Notes

## Docker Should Be The Default Participant Path

The live demo worked, but `tmux` was a poor dependency for a mixed workshop audience. Some Windows participants could not install or run it during the session. The TUI/tmux flow is useful for the facilitator machine, but it should not be the required hands-on path.

For the next version, make Docker or a Dev Container the default participant setup:

- `Dockerfile`
- `docker-compose.yml`
- optional `.devcontainer/devcontainer.json`
- app exposed on `4317`
- gold/reference app optionally exposed on `4318`
- tests runnable inside the same container
- no `tmux` requirement for participants

The ideal participant path should be:

```bash
git clone https://github.com/statewright/statewright
cd statewright/docs/outreach/techpoint-xtern-june-2026
docker compose up
```

Then participants open `http://localhost:4317` and use a second terminal for tests:

```bash
docker compose run --rm demo npm test
```

## Keep tmux As Facilitator-Only

The BBS-style TUI is still valuable for live-solving on the overhead screen:

- creates dirty arenas
- launches Claude/Codex side by side
- runs tests
- starts dirty and gold servers

But it should be documented as a facilitator tool, not as the main workshop requirement.

## Statewright Setup Needs Earlier Placement

Participants needed Statewright installed before the exercise. The README now includes install instructions, but future workshops should introduce this before the hands-on segment and leave time for account/API-key setup.
