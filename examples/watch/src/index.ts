import {createServer} from 'http';

const server = createServer((req, res) => {
  res.writeHead(200);
  res.write('hello from watch');
  res.end();
});


server.listen(8080, () => {
  console.log('listening 8080')
})
