import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('GET /api/conversations/:id validates input', async () => {
    // Import server to start it
    const module = await import('../backend/server.js');
    const { config } = await import('../backend/config.js');
    
    // We send an excessively long ID
    const res = await fetch(`http://localhost:${config.port}/api/conversations/invalid-id-that-is-way-too-long-long-long-long-long-long-long-long-long-long-long-long-long-long`);
    assert.equal(res.status, 400);

    // Stop server
    process.emit('SIGTERM', 'SIGTERM');
});