# Claude Code 前置路由(anyrouter-proxy)

一个开源的奇异搞笑路由器 由Doubao-Seed-2.1-Bro™和Doubao™网页端编写而成。100%vibe无手写。
<img width="298" height="184" alt="image" src="https://github.com/user-attachments/assets/72023c82-a1f6-4b8c-a68f-65ede56eb6d5" />
<img width="128" height="128" alt="image" src="https://github.com/user-attachments/assets/73dc0edc-f086-4ccd-8564-57f286c366be" />

> ⚠️ 本仓库仅供学习与研究目的发布。若使用导致账号遭到禁令，请自行承担后果。

# 奇异搞笑

<img width="220" alt="9793fce877f325893985f2d9d5ff806f" src="https://github.com/user-attachments/assets/1ae4787a-e4e9-4510-b19b-6c92ae30b566" />
<img width="220" alt="75b31b870ec0e266782e07ce153e5992" src="https://github.com/user-attachments/assets/1258bcae-1d78-4b38-91d2-e2c74ed94de0" />
<img width="220" alt="f0980613c8a1262f076bfecaa0f1f3cc" src="https://github.com/user-attachments/assets/68f0b9b2-0100-4c87-9662-91baf868ed90" />
<img width="220" alt="1c55ece3f756d0019d52d18acaacc2a7" src="https://github.com/user-attachments/assets/fdd79760-ddf2-41bd-b095-29faf526c8aa" />
<img width="220" alt="43776a846ca9d4bc65db010d5bf25457" src="https://github.com/user-attachments/assets/c2e6596c-2c5d-4ae2-973b-6f0892b1f7fc" />
<img width="220" alt="ebf87da541869da9d0ac5b0a5b127c7c" src="https://github.com/user-attachments/assets/e2e54592-c863-4113-84e7-0afa56960459" />

# 嗯对

单文件、零依赖,只要装了 Node(≥18,CC 本身就依赖它)即可运行。

## 用法

**1. 启动代理**(任选其一):

```bat
:: 方式一:直接跑(默认上游读同目录 default-upstream.txt,详见下文)
node cc-proxy.js

:: 方式二:自定义端口 / 上游
node cc-proxy.js 8118 https://你的中转站域名
:: 或用环境变量:PORT=8118 UPSTREAM=https://你的中转站域名 node cc-proxy.js
```

**2. 让 Claude Code 走代理**。Key 保持你现在的配置不变(`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`,代理原样透传,不改写任何鉴权头),只需把 Base URL 指到本机:

```bat
:: cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8118
claude
```

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8118"
claude
```

想永久生效,写进 `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8118" } }
```

**懒人方式**:双击 `start-cc.bat` —— 启动时让你输入上游地址:

- 直接回车 = 使用默认上游(同目录 `default-upstream.txt`,该文件不入库,写一次你的地址即可)
- 也可以当参数传:`start-cc.bat https://你的中转站域名`
- 重复执行会自动停掉旧实例、按新输入的上游重启

Key 任何时候都不用在脚本里输入:CC 请求带什么 Key(`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`),代理就原样透传什么。

## 行为说明

- 请求侧:`method / path / body` 及所有头(`authorization`、`x-api-key`、`anthropic-version` 等)原样透传,仅改写 `Host`、`Accept-Encoding`(强制明文以便扫描)和 `Content-Length`。
- 流式响应(`text/event-stream`):逐事件透传;`message_stop` 完整输出后立即 `end()` 并掐断上游连接。
  - 用 Buffer 按 SSE 空行边界切事件,`message_stop` 跨 chunk、中文多字节截断都不会误判/乱码;
  - 判定只认 `data:` 行 JSON 的 `type:"message_stop"`(或 `event: message_stop` 行),模型正文里恰好写出 `{"type":"message_stop"}` 的示例代码不会误触发;
  - 兜底:个别中转站连事件结束空行都不发,只要 `data` 行完整也会补齐并断开。
- 非流式及其他路径(count_tokens 等):纯管道透传,不做任何干预。
- 空回复治理:流式响应在收到首个 `content_block_delta` 前不向 CC 发响应头;若流结束/中断/超时仍没有任何内容(含"只有 ping""只有 message_start/stop 的空消息"等形态),不转发,改返回 **529 overloaded_error**(CC 会自动重试)。空闲上限默认 90 秒,可用环境变量 `FIRST_EVENT_TIMEOUT_MS` 调整(0 = 不限时);上游返回 4xx/5xx 时不做此改造,原样透传由 CC 自行处理。
- 代理层自动重试:上游 5xx(520/529 等)、连接失败、空回复,只要还没向 CC 转发过任何字节,代理先内部重试——默认重试 2 次、间隔 1 秒(环境变量 `UPSTREAM_RETRIES` / `RETRY_DELAY_MS` 可调),瞬时抖动对 CC 完全透明;额度用尽才把最后的错误交给 CC(5xx 原样、空回复转 529、连接错误转 502)。
- 上游经本地代理:https 上游默认经 `127.0.0.1:10808` 以 CONNECT 隧道转发(实测该中转站直连会被 TLS 拒绝)。优先取环境变量 `HTTPS_PROXY`/`https_proxy` 等(CC 同样遵循),没有时用内置默认——终端注入的代理变量(如 ZCode)对双击启动的进程无效,内置默认不可少;设 `UPSTREAM_PROXY=direct` 或 `NO_PROXY` 可强制直连。
- 连接兜底:上游"连接 + 响应头"默认 600 秒未到达才判本次尝试失败并重试(中转站排队时可能久等,过短会误杀;环境变量 `CONNECT_TIMEOUT_MS` 可调,0 = 关闭);响应头到达后不再限时,慢速流式不受影响。
- CC 侧主动中断(按 Esc)时,同步掐断上游。
- 每个请求在代理窗口打一行日志(状态、耗时、是否提前断开),方便观察。

## 文件

| 文件 | 说明 |
| --- | --- |
| `cc-proxy.js` | 代理主体,单文件零依赖 |
| `start-cc.bat` | 启动代理(上游地址可作参数传入或运行时输入;重复执行自动重启旧实例) |
| `test/mock-upstream.js` | 模拟"不关连接"的中转站,用于本地回归测试 |
| `default-upstream.txt` | (可选,本地文件不入库)写入你的默认上游地址,`start-cc.bat` 回车即用它 |

## 已验证(本地端到端)

- 原问题复现:直连模拟中转站,连接永不关闭,客户端只能干等超时;走本代理后完整收到全部事件(含 220KB 中文、正文陷阱文本、跨 chunk 拆包的 `message_stop`),**0.35 秒**即返回。
- Key / anthropic-version 等头原样到达上游;非流式 4ms 透传。
- 启动脚本:参数传入与直接回车两种方式均正常;重复执行自动重启旧实例;bat 内保持 ASCII(GBK 控制台下 UTF-8 中文会被错误解析)。
- 真实上游:直连 TLS 被拒(alert 40),经 `HTTPS_PROXY` 隧道后假 key 得到上游 401(链路全通,未消耗配额);错协议上游 0.01 秒返回 502。
