# Statewright credentials

`statewright-credentials` is the narrow native boundary between Statewright's
JavaScript plugin runtime and the operating system credential store. It uses:

- macOS Keychain via Security Framework;
- Windows Credential Manager;
- Linux Secret Service with the kernel keyring persistence adapter.

Each credential is stored under service `ai.statewright.gateway`. The account is
`v1:` plus the SHA-256 digest of the canonical gateway URL, so production,
staging, and development gateways cannot accidentally share a token.

The helper accepts one bounded JSON request on stdin and returns one JSON
response on stdout. Secrets are never accepted in argv. Supported operations are
`get`, `set`, `status`, and `delete`.

Headless Linux systems must provide a usable Secret Service session. There is no
plaintext fallback; automation can use the explicit, process-scoped
`STATEWRIGHT_API_KEY` override.
