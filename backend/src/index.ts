import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.text(`my name is ${process.env.NAME}`))

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
}
