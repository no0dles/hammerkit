const { createServer } = require('http')

const server = createServer((req, res) => {
  res.writeHead(200)
  res.write('hello from watch2')
  res.end()
})

process.on('SIGINT', () => {
  console.log('SIGINT')
  server?.close()
  //process.exit()
})

server.listen(8080, '0.0.0.0', () => {
  console.log('listening :8080')
  console.log('ready to serve')
})
