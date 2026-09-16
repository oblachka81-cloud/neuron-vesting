// bot/api.js — REST API for locks
const db = require('./db');

function addRoutes(req, res) {
  if (req.url.startsWith('/locks?')) {
    const url = new URL(req.url, 'http://localhost');
    const wallet = url.searchParams.get('wallet');
    if (!wallet) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wallet param required' }));
      return true;
    }
    db.getLocks(wallet).then((locks) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ locks }));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }
  
  if (req.url === '/stats') {
    db.getStats().then((stats) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }
  
  return false;
}

module.exports = { addRoutes };
