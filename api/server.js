const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const ACCESS_KEY = process.env.PROXY_SECRET_KEY || "fallback_default_key";

let espSocket = null;
const pendingRequests = new Map();
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 1. Create a native HTTP server wrapping Express
const server = http.createServer(app);

// 2. Attach WebSocket Server to that exact instance
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    console.log('[SYSTEM] ESP8266 successfully established WebSocket tunnel.');
    espSocket = ws;

    ws.on('message', (message) => {
        try {
            const rawString = message.toString();
            if (rawString === '{"type":"ping"}') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            const parts = rawString.split('|||DATA_SEP|||');
            if (parts.length >= 3) {
                const txId = parts[0];
                const statusCode = parseInt(parts[1], 10) || 200;
                const bodyPayload = parts[2];

                const res = pendingRequests.get(txId);
                if (res) {
                    res.status(statusCode);
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.send(bodyPayload);
                    pendingRequests.delete(txId);
                }
            }
        } catch (err) {
            console.error('WS payload parsing error:', err);
        }
    });

    ws.on('close', () => {
        if (espSocket === ws) espSocket = null;
    });
});

// 3. Update the route scanner to step aside for WebSocket requests
app.all('*', (req, res) => {
    // CRITICAL: Let WebSocket handshake pass through without security checks
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        return; 
    }

    const providedKey = req.query.key;
    if (!providedKey || providedKey !== ACCESS_KEY) {
        return res.status(401).send('<h1>401 Unauthorized</h1><p>Invalid Security Key.</p>');
    }
    if (!espSocket || espSocket.readyState !== 1) {
        return res.status(503).send('<h1>503 Service Unavailable</h1><p>ESP8266 Offline.</p>');
    }

    const txId = crypto.randomUUID();
    pendingRequests.set(txId, res);

    const flatPayload = `${txId}|${req.method}|${req.url}`;
    espSocket.send(flatPayload);

    setTimeout(() => {
        if (pendingRequests.has(txId)) {
            pendingRequests.delete(txId);
            res.status(504).send('<h1>504 Gateway Timeout</h1>');
        }
    }, 15000);
});

// CRITICAL FOR VERCEL WEBSOCKETS: Export the server instance
module.exports = server;
