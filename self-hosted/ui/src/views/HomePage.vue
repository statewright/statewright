<template>
  <div class="min-h-screen bg-white">
    <div class="max-w-4xl mx-auto px-4 py-16 text-center">
      <h1 class="text-4xl font-bold text-gray-900 mb-4">Statewright</h1>
      <p class="text-lg text-gray-600 mb-12">State machine guardrails for AI agents. Self-hosted.</p>

      <div class="grid md:grid-cols-3 gap-6 text-left">
        <router-link to="/workflows" class="block bg-gray-50 border border-gray-200 rounded-lg p-6 hover:border-brand-300 transition-colors">
          <h2 class="font-semibold text-gray-900 mb-2">Workflows</h2>
          <p class="text-sm text-gray-600">Create and edit state machine workflows that control agent behavior.</p>
        </router-link>

        <router-link to="/runs" class="block bg-gray-50 border border-gray-200 rounded-lg p-6 hover:border-brand-300 transition-colors">
          <h2 class="font-semibold text-gray-900 mb-2">Runs</h2>
          <p class="text-sm text-gray-600">Monitor active workflow runs, transitions, and tool logs in real time.</p>
        </router-link>

        <router-link to="/keys" class="block bg-gray-50 border border-gray-200 rounded-lg p-6 hover:border-brand-300 transition-colors">
          <h2 class="font-semibold text-gray-900 mb-2">API Keys</h2>
          <p class="text-sm text-gray-600">Generate keys for the MCP gateway to authenticate agent connections.</p>
        </router-link>
      </div>

      <!-- Support this project -->
      <div class="mt-16 bg-gray-50 border border-gray-200 rounded-lg p-8 text-left">
        <h2 class="font-semibold text-gray-900 mb-3 text-center">Support this project</h2>
        <p class="text-sm text-gray-600 mb-5 text-center">Statewright is free to self-host. If it saves you time, consider supporting continued development.</p>

        <div class="grid sm:grid-cols-2 gap-4">
          <a href="https://github.com/statewright/statewright" target="_blank" class="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:border-brand-300 transition-colors">
            <svg class="w-5 h-5 text-gray-700 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            <div>
              <span class="text-sm font-medium text-gray-900">Star on GitHub</span>
              <span class="text-xs text-gray-500 block">statewright/statewright</span>
            </div>
          </a>

          <a href="https://statewright.ai" target="_blank" class="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:border-brand-300 transition-colors">
            <svg class="w-5 h-5 text-brand-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/></svg>
            <div>
              <span class="text-sm font-medium text-gray-900">Managed Cloud</span>
              <span class="text-xs text-gray-500 block">Skip the infra, start at statewright.ai</span>
            </div>
          </a>

          <a href="https://github.com/sponsors/statewright" target="_blank" class="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:border-brand-300 transition-colors">
            <svg class="w-5 h-5 text-pink-500 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <div>
              <span class="text-sm font-medium text-gray-900">Sponsor</span>
              <span class="text-xs text-gray-500 block">One-time or monthly via GitHub Sponsors</span>
            </div>
          </a>

          <a href="https://statewright.ai/newsletter" target="_blank" class="flex items-center gap-3 px-4 py-3 bg-white border border-gray-200 rounded-lg hover:border-brand-300 transition-colors">
            <svg class="w-5 h-5 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
            <div>
              <span class="text-sm font-medium text-gray-900">Stay in the loop</span>
              <span class="text-xs text-gray-500 block">Recipes, releases, research — via statewright.ai mailing</span>
            </div>
          </a>
        </div>

        <div class="mt-5 pt-4 border-t border-gray-100 text-center">
          <p class="text-xs text-gray-400 mb-2">Also by us</p>
          <div class="flex justify-center gap-4 text-xs">
            <a href="https://github.com/statewright/trove" target="_blank" class="text-brand-500 hover:underline" title="S3-compatible object storage">Trove <span class="text-gray-400">— S3-compatible object storage</span></a>
            <span class="text-gray-300">&middot;</span>
            <a href="https://github.com/statewright/pg-pocketbase" target="_blank" class="text-brand-500 hover:underline" title="PocketBase with Postgres for multi-pod scaling">pg-pocketbase <span class="text-gray-400">— PocketBase on Postgres</span></a>
          </div>
        </div>
      </div>

      <div class="mt-8 text-sm text-gray-400">
        <a href="https://docs.statewright.ai" target="_blank" class="text-brand-500 hover:underline">Documentation</a>
        <span class="mx-2">&middot;</span>
        <a href="https://github.com/statewright/statewright" target="_blank" class="text-brand-500 hover:underline">GitHub</a>
      </div>
    </div>
  </div>
</template>
