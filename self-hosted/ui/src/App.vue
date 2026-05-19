<template>
  <div class="min-h-screen bg-white">
    <nav class="border-b border-gray-200 px-6 py-3">
      <div class="max-w-5xl mx-auto flex items-center justify-between">
        <router-link to="/" class="font-bold text-lg text-gray-900">Statewright</router-link>
        <div class="flex items-center gap-6 text-sm">
          <router-link to="/workflows" class="text-gray-600 hover:text-gray-900" active-class="text-brand-600 font-medium">Workflows</router-link>
          <router-link to="/runs" class="text-gray-600 hover:text-gray-900" active-class="text-brand-600 font-medium">Runs</router-link>
          <router-link to="/keys" class="text-gray-600 hover:text-gray-900" active-class="text-brand-600 font-medium">API Keys</router-link>
        </div>
      </div>
    </nav>
    <router-view />
    <footer class="border-t border-gray-100 py-4 text-center text-xs text-gray-400">
      Powered by <a href="https://statewright.ai" class="text-brand-500 hover:underline" target="_blank">Statewright</a>
    </footer>
  </div>
</template>
