#!/usr/bin/env node
'use strict';

/**
 * Claude Code 前置路由(零依赖,单文件)
 *
 * 解决的问题:部分中转站在 SSE 输出 message_stop 之后不关闭连接,
 * 导致 Claude Code 只能干等到超时才能进入下一轮。
 *
 * 工作方式:本机起一个 HTTP 服务,Claude Code 把 ANTHROPIC_BASE_URL 指向它;
 * 它把请求(含 API Key 等所有鉴权头)原样转发给上游中转站;
 * 对流式响应逐事件透传,一旦 message_stop 事件完整输出,立即结束响应并断开上游。
 * 其余请求(非流式、count_tokens 等)原样透传。
 *
 * 配置:命令行参数 > 环境变量 > 默认值
 *   node cc-proxy.js [端口] [上游地址]
 *   PORT=8118 UPSTREAM=https://你的中转站域名 node cc-proxy.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const PORT = Number(args[0] || process.env.PORT || 8118);
const HOST = process.env.HOST || '127.0.0.1';
// 默认上游:优先读同目录 default-upstream.txt(本地文件,已被 .gitignore 排除、不会推送),
// 便于双击启动时直接回车即用;没有该文件则用占位符,请以参数/环境变量/该文件任一方式指定上游。
const LOCAL_DEFAULT_FILE = path.join(__dirname, 'default-upstream.txt');
const DEFAULT_UPSTREAM = (fs.existsSync(LOCAL_DEFAULT_FILE) && fs.readFileSync(LOCAL_DEFAULT_FILE, 'utf8').trim()) ||
  'https://your-relay.example.com';
const UPSTREAM_RAW = args[1] || process.env.UPSTREAM || DEFAULT_UPSTREAM;
let UPSTREAM;
try {
  UPSTREAM = new URL(UPSTREAM_RAW.endsWith('/') ? UPSTREAM_RAW.slice(0, -1) : UPSTREAM_RAW);
} catch {
  console.error(`[cc-proxy] 上游地址无效: "${UPSTREAM_RAW}"`);
  console.error('请用 UPSTREAM 环境变量或第 1 个参数指定合法地址,例如: set UPSTREAM=https://你的中转站域名');
  process.exit(1);
}
const BASE_PATH = UPSTREAM.pathname === '/' ? '' : UPSTREAM.pathname;

// 上游 https 连接是否经由本地代理(CONNECT 隧道)。
// Claude Code 遵循 HTTPS_PROXY/https_proxy 环境变量,本代理保持同样行为;
// 但这些变量通常由终端注入,双击 bat 启动时往往不存在——
// 而实测该中转站直连会被 TLS 拒绝(alert 40),必须经本机 VPN 客户端(10808)。
// UPSTREAM_PROXY=direct 可强制直连;NO_PROXY=* 或含上游主机名亦可。
const RAW_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy
  || process.env.ALL_PROXY || process.env.all_proxy
  || process.env.UPSTREAM_PROXY || '';
const PROXY_FROM_ENV = RAW_PROXY.length > 0;
let UPSTREAM_PROXY = null;
if (/^(direct|off|none)$/i.test(RAW_PROXY)) {
  UPSTREAM_PROXY = null; // 显式禁用
} else {
  try { UPSTREAM_PROXY = new URL(RAW_PROXY || 'http://127.0.0.1:10808'); } catch { /* 无效代理地址,视为直连 */ }
}
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const noProxyMatch = () => NO_PROXY.some((p) =>
  p === '*' || UPSTREAM.hostname.toLowerCase() === p || UPSTREAM.hostname.toLowerCase().endsWith(p.startsWith('.') ? p : `.${p}`));

// 空回复治理:流式响应收到首个 content_block_delta 前不向 CC 转发;
// 超过此时长仍无内容视为空回复,返回 529 overloaded_error 让 CC 自动重试(0 = 不限时)
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.FIRST_EVENT_TIMEOUT_MS || 90_000);

// 上游 5xx / 连接失败 / 空回复的代理层自动重试次数(仅限未向 CC 转发任何字节时);
// 重试间隔 RETRY_DELAY_MS,默认 1 秒
const UPSTREAM_RETRIES = Math.max(0, Number(process.env.UPSTREAM_RETRIES ?? 2));
const RETRY_DELAY_MS = Math.max(0, Number(process.env.RETRY_DELAY_MS ?? 1000));

// 上游"连接 + 响应头"超时:超过视为本次尝试失败并重试(0 = 不限时)。
// 中转站排队时可能迟迟不给响应头,过短会误杀,默认 60 秒
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 60_000);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const log = (...a) => console.error(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

// 逐行检查一个完整 SSE 事件,判断是否 message_stop。
// 只认 data 行里 JSON 的 type 字段或 event 行,避免把模型正文里
// 恰好写着 "type":"message_stop" 的示例代码误判成流结束。
function isMessageStopEvent(eventText) {
  for (const rawLine of eventText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      try {
        if (JSON.parse(payload)?.type === 'message_stop') return true;
      } catch { /* data 行不是合法 JSON,忽略 */ }
    } else if (/^event:\s*message_stop\s*$/.test(line)) {
      return true;
    }
  }
  return false;
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const chunks = [];

  req.on('data', (c) => chunks.push(c));
  req.on('error', () => {});
  res.on('error', () => {});
  req.on('end', () => forward(Buffer.concat(chunks)));

  const logLine = (extra) =>
    log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms ${extra}`);

  function forward(body) {
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) {
      if (HOP_BY_HOP.has(h) || h === 'host' || h === 'content-length' || h === 'accept-encoding') delete headers[h];
    }
    // 鉴权头(authorization / x-api-key / anthropic-version 等)全部原样透传,仅改写以下几项:
    headers.host = UPSTREAM.host;
    // 要求明文响应,保证能扫描 SSE 内容(本机代理,带宽无碍)
    headers['accept-encoding'] = 'identity';
    if (body.length > 0) headers['content-length'] = String(body.length);

    const fail = (err) => {
      // 注意:不能用 upReq.destroyed 判断是否忽略——超时/复位路径里 socket 已销毁但客户端还没等到响应
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      log(`✗ 上游错误 ${req.method} ${req.url}: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `upstream error: ${err.message}` },
      }));
    };

    // 代理层自动重试:上游 5xx / 连接失败 / 空回复,只要尚未向 CC 转发任何字节就内部重试,
    // 重试额度用完才交给 CC(5xx 原样透传、空回复转 529、连接错误转 502)
    const maxAttempts = UPSTREAM_RETRIES + 1;
    let attempt = 0;

    const scheduleRetry = (why) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return false;
      if (attempt >= maxAttempts) return false;
      log(`↻ ${why}(第 ${attempt}/${maxAttempts} 次尝试),${RETRY_DELAY_MS}ms 后重试`);
      setTimeout(startAttempt, RETRY_DELAY_MS);
      return true;
    };

    const failOrRetry = (err) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      if (!scheduleRetry(err.message)) fail(err);
    };

    const startAttempt = () => {
      if (res.destroyed || res.writableEnded) return; // CC 已放弃
      attempt++;

      const issueUpReq = (tunnelSocket) => {
      const send = UPSTREAM.protocol === 'https:' ? https.request : http.request;
      // 仅约束"连接 + 等响应头"阶段(上游地址协议写错/上游不可达时会无限挂起);
      // 响应头一旦到达立即解除,不影响慢速的流式输出
      let gotResponse = false;
      const reqOpts = {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: BASE_PATH + req.url,
        headers,
      };
      if (tunnelSocket) {
        // https 经本地代理:在 CONNECT 隧道的裸 socket 上做 TLS 升级。
        // 注意必须用 socket 选项——https.request 会静默忽略 createConnection,
        // 导致看似走了隧道、实际直连(直连被上游 TLS 拒绝)。
        reqOpts.agent = false;
        reqOpts.socket = tunnelSocket;
        reqOpts.servername = UPSTREAM.hostname;
      }
      const upReq = send(reqOpts, (upRes) => {
        gotResponse = true;
        if (upRes.socket) upRes.socket.setTimeout(0);
        const outHeaders = { ...upRes.headers };
        for (const h of Object.keys(outHeaders)) if (HOP_BY_HOP.has(h)) delete outHeaders[h];

        const status = upRes.statusCode || 502;
        const isSSE = String(outHeaders['content-type'] || '').includes('text/event-stream');

        // 上游 5xx(520/529 等):还没向 CC 转发任何字节,缓冲完直接代理层重试
        if (status >= 500) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('error', () => {});
          upRes.on('end', () => {
            if (scheduleRetry(`上游 ${status}`)) return;
            delete outHeaders['content-length'];
            res.writeHead(status, outHeaders);
            res.end(Buffer.concat(chunks));
            logLine(`(上游持续 ${status},已重试 ${maxAttempts - 1} 次仍失败,交还 CC 处理)`);
          });
          return;
        }

        if (!isSSE) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('error', () => {});
          upRes.on('end', () => {
            res.writeHead(status, outHeaders);
            res.end(Buffer.concat(chunks));
            logLine('(非流式,透传完成)');
          });
          return;
        }
        delete outHeaders['content-length']; // 提前断开时长度必然对不上
        // 响应头交给 proxySSE:需先缓冲判定是否空回复,再决定转发、代理层重试还是返回可重试错误
        proxySSE(upReq, upRes, status, outHeaders, () => scheduleRetry('上游空回复'));
      });

      // 同一次尝试的 socket 可能接连弹出多个错误(超时 destroy 后再来一个 ECONNRESET),
      // 只处理第一个,否则重试被重复安排、尝试次数被虚耗。
      // 注意:置位只在下方错误处理器里做——超时回调若提前置位,emit 的错误会被自己吞掉
      let failureHandled = false;
      upReq.on('socket', (s) => {
        if (CONNECT_TIMEOUT_MS > 0) {
          s.setTimeout(CONNECT_TIMEOUT_MS, () => {
            if (!gotResponse && !failureHandled) {
              s.destroy();
              upReq.emit('error', new Error(`upstream connect/response timeout (${Math.round(CONNECT_TIMEOUT_MS / 1000)}s)`));
            }
          });
        }
      });

      // 响应头之前的一切失败(连接错误/连接超时)都走重试;响应头之后由 proxySSE 自行处理
      upReq.on('error', (err) => {
        if (failureHandled || gotResponse || res.headersSent || res.writableEnded || res.destroyed) return;
        failureHandled = true;
        failOrRetry(err);
      });

      if (body.length > 0) upReq.write(body);
      upReq.end();

      // CC 侧主动断开(例如按 Esc 中断)时,同步断开上游
      res.on('close', () => upReq.destroy());
      };

      if (UPSTREAM.protocol === 'https:' && UPSTREAM_PROXY && !noProxyMatch()) {
        const targetPort = UPSTREAM.port || 443;
        const target = `${UPSTREAM.hostname}:${targetPort}`;
        const tunnelHeaders = { host: target };
        if (UPSTREAM_PROXY.username) {
          tunnelHeaders['proxy-authorization'] = 'Basic ' + Buffer
            .from(`${decodeURIComponent(UPSTREAM_PROXY.username)}:${decodeURIComponent(UPSTREAM_PROXY.password || '')}`)
            .toString('base64');
        }
        const tunnel = http.request({
          host: UPSTREAM_PROXY.hostname,
          port: UPSTREAM_PROXY.port || 80,
          method: 'CONNECT',
          path: target,
          headers: tunnelHeaders,
        });
        tunnel.setTimeout(15_000, () => {
          tunnel.destroy();
          failOrRetry(new Error(`代理 CONNECT 超时(15s): ${UPSTREAM_PROXY.host}`));
        });
        tunnel.on('connect', (tRes, socket) => {
          if (tRes.statusCode !== 200) {
            socket.destroy();
            failOrRetry(new Error(`代理 CONNECT 失败: HTTP ${tRes.statusCode}`));
            return;
          }
          issueUpReq(socket);
        });
        tunnel.on('error', failOrRetry);
        tunnel.end();
      } else {
        issueUpReq(null);
      }
    };

    startAttempt();
  }

  function proxySSE(upReq, upRes, status, outHeaders, onEmpty) {
    let buf = Buffer.alloc(0);
    let done = false;          // 流已终态(提前断开/结束/失败)
    let live = status >= 400;  // 错误状态码原样透传,不做空回复改造
    let pending = [];          // 响应头发出前缓冲的完整事件
    let pendingBytes = 0;

    const eventType = (eventText) => {
      for (const rawLine of eventText.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('data:')) {
          try { return JSON.parse(line.slice(5).trim())?.type || null; } catch { return null; }
        }
      }
      return null;
    };

    const finishEarly = () => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      logLine('(已输出 message_stop,提前断开 ✓)');
      res.end();
      upReq.destroy();
    };

    const retryableFail = (why) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      upReq.destroy();
      if (live) { // 已开始转发,无法撤回,只能就地结束
        if (!res.writableEnded) res.end();
        logLine(`(${why},但已开始转发,仅截断)`);
        return;
      }
      // 还有重试额度就由代理层直接重试(对 CC 完全透明)
      if (onEmpty && onEmpty()) return;
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Upstream returned an empty response (cc-proxy: please retry)' },
      }));
      logLine(`(${why} → 已返回 529 让 CC 自动重试)`);
    };

    const flush = () => {
      if (live) return;
      live = true;
      clearTimeout(idleTimer);
      res.writeHead(status, outHeaders);
      for (const e of pending) res.write(e);
      pending = [];
      pendingBytes = 0;
    };

    const idleTimer = live || FIRST_EVENT_TIMEOUT_MS <= 0 ? null
      : setTimeout(() => retryableFail(`上游 ${Math.round(FIRST_EVENT_TIMEOUT_MS / 1000)}s 内无任何内容`), FIRST_EVENT_TIMEOUT_MS);

    upRes.on('data', (chunk) => {
      if (done || res.destroyed || res.writableEnded) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      // 切完整事件(SSE 以空行分隔;Buffer 缓冲,跨 chunk 的 UTF-8 不撕裂)
      for (;;) {
        const iLF = buf.indexOf('\n\n');
        const iCRLF = buf.indexOf('\r\n\r\n');
        let cut = -1, sep = 0;
        if (iLF !== -1 && (iCRLF === -1 || iLF <= iCRLF)) { cut = iLF; sep = 2; }
        else if (iCRLF !== -1) { cut = iCRLF; sep = 4; }
        if (cut === -1) break;

        const eventText = buf.subarray(0, cut + sep).toString('utf8');
        buf = buf.subarray(cut + sep);

        if (live) {
          res.write(eventText);
          if (isMessageStopEvent(eventText)) return finishEarly();
          continue;
        }

        // 缓冲阶段:等首个 content_block_delta 证明这条流有真实内容
        pending.push(eventText);
        pendingBytes += eventText.length;
        if (eventType(eventText) === 'content_block_delta') flush();
        else if (pendingBytes > 2 * 1024 * 1024) flush(); // 防御:迟迟无 delta 但数据量已大,放行
      }

      // 兜底:上游发出了完整的 message_stop data 行却始终不给事件结束空行(仅 live 态需要)
      if (live && buf.length && buf[buf.length - 1] === 0x0a) {
        for (const rawLine of buf.toString('utf8').split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          if (line.startsWith('data:')) {
            try {
              if (JSON.parse(line.slice(5).trim())?.type === 'message_stop') {
                res.write(buf);
                res.write('\n\n');
                buf = Buffer.alloc(0);
                return finishEarly();
              }
            } catch { /* 忽略不完整/非法 data 行 */ }
          }
        }
      }
    });

    const upstreamGone = () => {
      if (done) return;
      if (live) { done = true; res.end(); }
      else retryableFail('上游连接中断,未收到任何内容');
    };
    upRes.on('aborted', upstreamGone);
    upRes.on('error', upstreamGone);
    upRes.on('end', () => {
      if (done) return;
      if (!live) return retryableFail('上游空回复(流已结束仍无内容)');
      done = true;
      if (buf.length) res.write(buf);
      res.end();
      logLine('(SSE,上游正常结束)');
    });
  }
});

// 防止极端 socket 边界情况把进程带走
process.on('uncaughtException', (e) => log('未捕获异常(已忽略):', e.message));
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝(已忽略):', e && e.message));

server.headersTimeout = 60_000;
server.requestTimeout = 0;      // 长请求不限时
server.keepAliveTimeout = 75_000;

server.listen(PORT, HOST, () => {
  log(`Claude Code 前置路由已就绪:http://${HOST}:${PORT}  →  ${UPSTREAM.origin}${BASE_PATH}`);
  log(UPSTREAM_PROXY && UPSTREAM.protocol === 'https:' && !noProxyMatch()
    ? `上游 https 连接经由本地代理 ${UPSTREAM_PROXY.host} 转发(${PROXY_FROM_ENV ? '取自环境变量' : '内置默认;可用环境变量 UPSTREAM_PROXY 覆盖,设为 direct 则直连'})`
    : '上游直连(未启用代理)');
  log('让 Claude Code 走本代理(在启动 cc 的终端里):');
  log(`  set ANTHROPIC_BASE_URL=http://${HOST}:${PORT}`);
  log('API Key 原样透传,无需任何改动。');
});
