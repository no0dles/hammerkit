const http = require('http')

const port = process.env.PORT || 3000

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end("it's Hammer Time!\n")
  })
  .listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`listening on ${port}`)
  })
