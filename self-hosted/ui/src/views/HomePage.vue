<template>
  <div class="min-h-screen bg-white">
    <div class="max-w-3xl mx-auto px-4 py-16 text-center">
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

      <div class="mt-16 text-sm text-gray-400">
        <a href="https://docs.statewright.ai" target="_blank" class="text-brand-500 hover:underline">Documentation</a>
        <span class="mx-2">&middot;</span>
        <a href="https://github.com/statewright/statewright" target="_blank" class="text-brand-500 hover:underline">GitHub</a>
      </div>
    </div>
  </div>
</template>
