// Tiny web server for tests: node web.js <port> [--fallback] [--fail]
// --fallback: when the port is taken, listen on the next one (like Vite).
import http from 'node:http';

const port = Number(process.argv[2]);
if (process.argv.includes('--fail')) {
  console.error('Error: boom');
  process.exit(3);
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>fixture</title>ok');
});
let p = port;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && process.argv.includes('--fallback')) {
    p += 1;
    server.listen(p, '127.0.0.1');
  } else {
    console.error(e.message);
    process.exit(1);
  }
});
server.on('listening', () => console.log('listening on', server.address().port));
server.listen(p, '127.0.0.1');
