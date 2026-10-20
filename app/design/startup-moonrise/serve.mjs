import http from 'node:http'
import { readFile } from 'node:fs/promises'

const server = http.createServer(async (request,response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname !== '/' && url.pathname !== '/preview.html') {
    response.writeHead(404); response.end(); return
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(await readFile(new URL('preview.html',import.meta.url)))
})
server.listen(5182,'127.0.0.1',()=>console.log('Stringmoon motion preview: http://127.0.0.1:5182'))
