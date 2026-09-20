#!/usr/bin/env node
'use strict';

/**
 * 模拟"行为不端"的中转站:
 * - 流式:SSE 正常输出,但 message_stop 之后故意不关闭连接(复现 CC 卡 30 秒的问题)
 * - message_stop 事件拆成两次 write(跨 chunk)
 * - 正文里埋一个假的 "type":"message_stop" 文本(验证代理不误判)
 * - 一段较长的中文(验证 UTF-8 缓冲拼接无乱码)
 * - 把收到的鉴权头回显到日志(验证 Key 透传)
 * - stream:false 时返回普通 JSON
 *
 * 空回复模式(请求体加 "empty" 字段,模拟中转站空回复的多种形态):
 * - "end"      :SSE 响应头后一个事件都没有,直接结束
 * - "ping"     :只发 ping,然后结束
 * - "startstop":有 message_start/message_stop 但没有任何 delta(空消息)
 * - "stall"    :响应头后彻底沉默,永不结束(测代理的空闲超时)
 * - "late"     :先发 1 秒 ping,再正常输出完整流(测代理的缓冲放行)
 */

const http = require('http');

const hits = {}; // 各组合模式的命中次数:首次失败、后续正常,用于测代理层重试

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(`[mock] ${req.method} ${req.url} authorization=${JSON.stringify(req.headers['authorization'])} x-api-key=${JSON.stringify(req.headers['x-api-key'])} anthropic-version=${JSON.stringify(req.headers['anthropic-version'])}`);

    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_nonstream',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '非流式响应 OK' }],
        stop_reason: 'end_turn',
      }));
      return;
    }

    const mode = parsed.empty || 'normal';
    const hitNo = (hits[mode] = (hits[mode] || 0) + 1);

    // 520 必须在任何响应头写出之前返回(模拟 CF 源站错误、无 body)
    if ((mode === 'e520' || mode === 'e520once') && (mode === 'e520' || hitNo === 1)) {
      res.writeHead(520, { 'content-type': 'text/plain' });
      res.end('upstream error');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

    if (mode === 'end') { setTimeout(() => res.end(), 300); return; }

    if (mode === 'ping') {
      let n = 0;
      const t = setInterval(() => {
        ev('ping', { type: 'ping' });
        if (++n >= 10) { clearInterval(t); res.end(); }
      }, 300);
      return;
    }

    if (mode === 'startstop') {
      ev('message_start', { type: 'message_start', message: { id: 'msg_empty', type: 'message', role: 'assistant' } });
      ev('message_stop', { type: 'message_stop' });
      setTimeout(() => res.end(), 200);
      return;
    }

    if (mode === 'stall') { res.flushHeaders(); return; } // 立即发出响应头,之后彻底沉默

    if (mode === 'endonce' && hitNo === 1) { setTimeout(() => res.end(), 200); return; }

    // "late":先 1 秒 ping,再走正常流程
    const runNormal = () => {
      const bigText = '你好世界。'.repeat(20000); // ~220KB 中文,制造大 payload
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant' } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '陷阱:正文出现 {"type":"message_stop"} 不应触发提前断开;' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: bigText } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '结束哨兵SENTINEL-OK' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < events.length) { ev(...events[i++]); return; }
        clearInterval(timer);
        // message_stop 拆成两次 write,且之后永不 end()
        res.write('event: message_stop\ndata: {"type":"message');
        setTimeout(() => res.write('_stop"}\n\n'), 100);
      }, 30);
    };

    if (mode === 'late') {
      let n = 0;
      const t = setInterval(() => {
        ev('ping', { type: 'ping' });
        if (++n >= 3) { clearInterval(t); runNormal(); }
      }, 350);
      return;
    }

    runNormal();
  });
}).listen(9091, '127.0.0.1', () => console.log('[mock] 中转站模拟器已启动: http://127.0.0.1:9091'));
