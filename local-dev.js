import http from 'http';
import { URL } from 'url';

function parseQuery(searchParams) {
    const query = {};
    for (const [key, value] of searchParams.entries()) {
        if (query[key]) {
            if (Array.isArray(query[key])) {
                query[key].push(value);
            } else {
                query[key] = [query[key], value];
            }
        } else {
            query[key] = value;
        }
    }
    return query;
}

function enhanceResponse(res) {
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify(payload));
        return res;
    };
    res.send = (payload) => {
        if (Buffer.isBuffer(payload)) {
            res.end(payload);
            return res;
        }
        if (typeof payload === 'object') {
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json');
            }
            res.end(JSON.stringify(payload));
            return res;
        }
        res.end(String(payload));
        return res;
    };
    return res;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.query = parseQuery(url.searchParams);
    enhanceResponse(res);

    if (url.pathname === '/api4') {
        const { default: handler } = await import('./api/api4/index.js');
        return handler(req, res);
    }

    if (url.pathname === '/api5') {
        const { default: handler } = await import('./api/api5/index.js');
        return handler(req, res);
    }

    if (url.pathname === '/api/proxy') {
        const { default: handler } = await import('./api/proxy.js');
        return handler(req, res);
    }

    res.status(404).json({ status: 'error', message: 'Not found' });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
    console.log(`api4-standalone running on http://localhost:${port}`);
});
