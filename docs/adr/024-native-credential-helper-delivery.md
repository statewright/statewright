# Native credential-helper delivery

Status: implemented for the 0.3.9 candidate; hosted artifact acceptance pending.

## Context

Release ZIPs include platform credential helpers, while Git-subdirectory plugin
installs contain tracked source only. An existing global helper hid this gap on
provisioned machines. Native Claude OAuth remains owned by Claude and does not
require a Statewright API-key file; this decision concerns the shared native
credential adapter used by managed clients and Codex terminal/Desktop.

## Decision

Keep packaged, existing global and explicitly configured helper paths first.
When the default helper is absent, the shared adapter resolves the numeric
release tag from its own native plugin manifest. It fetches only that plugin's
published release in the fixed official GitHub repository. It does not select
`latest`, accept an arbitrary download endpoint or fall back to plaintext.

The release workflow publishes each supported platform helper as a standalone
asset, alongside a manifest containing the exact source commit, tag, size and
SHA256 for each binary. Both the manifest and binary must match GitHub's release
asset digests and sizes. The manifest source must equal the commit resolved by
the tag. URLs and redirects are restricted to HTTPS GitHub release infrastructure;
responses have time/size bounds and receive no Statewright credential.

This trusts the official GitHub repository/release authority and TLS, rather than
an independently embedded signing key. CI emits artifact attestations, but the
runtime bootstrap does not claim to verify Sigstore attestations. Relevant API
contracts: [release assets](https://docs.github.com/en/rest/releases/assets) and
[release metadata](https://docs.github.com/en/rest/releases/releases).

Verified bytes and a source/digest receipt are installed atomically under
`~/.statewright/helpers/<plugin-tag>/<platform>/`. Unix directories/files reject
foreign ownership, unsafe write permissions and symlinks. Cache reads reject
nonregular files and enforce bounds. Cached binary size/hash is checked before
reuse, including offline reuse. An invalid existing cache is not deleted or
overwritten automatically. The adapter never writes into the installed plugin,
changes hooks/security, or overwrites an existing global helper.

The release matrix includes native Intel macOS testing in addition to Apple
Silicon macOS, Linux x64 and Windows x64. Unsupported architectures fail explicitly.
See [GitHub runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Validation and rollout

Source tests cover both copied Git-package layouts, verified download followed by
actual synthetic helper-process invocation, offline reuse and existing global
helper precedence. Negative cases cover missing/changed metadata, source mismatch,
corrupt binaries, redirects, symlinks, oversized cache receipts and FIFOs. These
synthetic protocol tests are not real OS-vault or public-release acceptance.

Publication must include standalone helpers and the manifest from the same gated
build as the plugin ZIP. The unpublished candidate cannot bootstrap from GitHub
until those exact assets exist. Preserve hosted CI, native OS-vault clean-home,
installed-host and staging gates; no developer global helper substitutes for them.

## Recovery

Unpublished releases, unavailable networking, unsupported platforms, invalid
checksums or unsafe caches fail visibly without spawning downloaded bytes or
storing a credential. Preserve the receipt and use supported setup recovery for
the affected release; do not weaken checksum/security checks or borrow another
session's identity. Rollback of this source change reintroduces the clean-install
gap. No credential-store schema or stored credential migration changes here.
