import { createApp } from 'vue'
import PocketBase from 'pocketbase'
import App from './App.vue'
import router from './router'
import './assets/main.css'

const pb = new PocketBase(window.location.origin)

const app = createApp(App)
app.provide('pocketbase', pb)
app.use(router)
app.mount('#app')
