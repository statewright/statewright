import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('../views/HomePage.vue') },
    { path: '/workflows', component: () => import('../views/WorkflowList.vue') },
    { path: '/workflows/:id', component: () => import('../views/WorkflowEditor.vue') },
    { path: '/runs', component: () => import('../views/WorkflowRuns.vue') },
    { path: '/keys', component: () => import('../views/ApiKeys.vue') },
  ],
})

export default router
