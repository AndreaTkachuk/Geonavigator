import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const ViewerPage = () => import('../../pages/ViewerPage/index.vue')


const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/map',
  },
  {
    path: '/map',
    name: 'map',
    component: ViewerPage,
    props: { mapType: null },  // тип береться з конфігу
  },
  {
    path: '/map/2D',
    name: 'map2D',
    component: ViewerPage,
    props: { mapType: '2D' },
  },
  {
    path: '/map/3D',
    name: 'map3D',
    component: ViewerPage,
    props: { mapType: '3D' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/map',
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})