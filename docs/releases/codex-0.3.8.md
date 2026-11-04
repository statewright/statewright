# Statewright for Codex 0.3.8

This patch fixes an intermittent Windows owned App Server shutdown failure.
When Windows reports that the owned process is already gone, Statewright now
waits briefly for that child to close before accepting the result. If closure
cannot be confirmed within the existing grace period, shutdown still fails
with its bounded diagnostic instead of claiming success.

The plugin keeps the automatic, scrubbed error diagnostics introduced in
0.3.7. This update does not change workflow definitions, command permissions,
saved credentials, or the hosted gateway and website.

Install or update `statewright@statewright` through the Codex plugin manager.
Restart an affected client when its work is idle.
