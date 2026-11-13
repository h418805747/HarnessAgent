# OpenCLI 调研备忘

> 日期：2026-11-02（结论未变，2026-11-05 归档）
> 对象：`@jackwener/opencli` v2.0.2（Apache-2.0，Node ≥ 20.18.1，TypeScript/ESM）
> 目的：评估"浏览器工具（browser toolset）"该自研还是引入，以及可借鉴的设计
> 结论：**不引入依赖；借鉴 4 点设计，原语自研**

---

## 1. 它是什么

给 Agent 装一双"能操作已登录浏览器"的手：一个 CLI + 一套站点适配器 + 一个 Chrome 扩展桥。**没有模型、不规划**，属工具层，可被 Claude Code / Cursor 等装成 skill。

三层结构（边界干净，这是它最值得学的部分）：

| 层 | 内容 | 变化频率 |
|---|---|---|
| 命令层 | 100+ 站点适配器（声明式：认证方式 + 端点 + 字段解析 + 输出列） | 高 |
| 原语层 | `open` / `state` / `click` / `type` / `fill` / `wait` / `extract` / `eval` / `network` / `tab` / `screenshot` | 低 |
| 传输层 | Browser Bridge：Chrome 扩展 + 本地 daemon（`localhost:19825`），走 CDP 操作**用户已登录**的标签页 | 极低 |

## 2. 关键机制与操作原理

| 机制 | 说明 |
|---|---|
| **零凭据管理** | 复用 Chrome profile 的登录态，不存 token、不走扫码——这是它相对 Playwright 类方案的核心价值 |
| **租约模型** | `--session` 逻辑作用域，`--tab` 物理目标；site slot 池、idle 超时、只回收当前租约的自有标签页 |
| **Agent 友好契约** | 默认 `{ok:true,data}` / `{ok:false,error:{code,message,hint}}`；日志走 stderr；退出码遵循 `sysexits.h`（66 空结果 / 69 桥不可用 / 75 超时 / 77 需认证 / 78 配置错） |
| **适配器流水线** | recon（识别 SPA/SSR/JSONP/Token/Streaming）→ 选认证（`PUBLIC/COOKIE/INTERCEPT/UI/LOCAL`）→ `adapter init` → `adapter test`；站点知识沉淀到 `~/.opencli/sites/<site>/` |
| **结构化输出** | `--format json/table/yaml/md/csv` + 列定义，避免整页 HTML 灌进上下文 |
| **Web→Markdown** | `@mozilla/readability` + `turndown` |

## 2.1 它怎么操作 Chrome（链路与边界）

不是"Chrome 对外暴露了原语命令"，而是**扩展借 `chrome.debugger` 拿到 CDP 通道**。四个进程/协议边界：

```
┌─ CLI 进程（短命）──────────────────┐
│ opencli browser click --ref 12     │
└──────────────┬─────────────────────┘
               │ HTTP/WS  127.0.0.1:19825（带自定义头）
┌──────────────▼─────────────────────┐
│ daemon 进程（长命，按需自动拉起）    │  租约 / tab 绑定 / 会话状态 / 日志
└──────────────┬─────────────────────┘
               │ WebSocket（长连接）
┌──────────────▼─────────────────────┐
│ Chrome 扩展 service worker          │  chrome.debugger / scripting / tabs
└──────────────┬─────────────────────┘
               │ CDP（sessionId 绑定到具体 tab）
┌──────────────▼─────────────────────┐
│ 目标标签页（renderer）              │
└────────────────────────────────────┘
```

| 层 | 真实协议 | 作用 |
|---|---|---|
| CLI → daemon | 本地 HTTP / WS（`localhost:19825`，`/status`、`/logs`） | 命令下发、结果回传；CLI 可短命，状态留在 daemon |
| daemon → 扩展 | WebSocket 长连接 | 寻址到具体 Chrome profile / tab，维持租约 |
| 扩展 → 页面 | **`chrome.debugger`（底层就是 CDP）** | `Page.navigate`、`Runtime.evaluate`、`DOM.*`、`Input.dispatchMouseEvent`、`Page.captureScreenshot`、`Network.*` |
| 扩展辅助 | `chrome.scripting` / `chrome.tabs` / `cookies` | 注入脚本、枚举标签页、读站点 Cookie（适配器的 `COOKIE` 认证方式） |

**为什么绕道扩展而不直连 CDP**

1. 直连要求 Chrome 以 `--remote-debugging-port` 启动，通常意味着**独立 profile**——那就没有用户的登录态，核心价值没了。
2. Chrome 对默认 profile 暴露 CDP 有额外限制，日常浏览器开不了远程调试。
3. 扩展能常驻在用户**日常使用的那一个 Chrome** 里，随开随用。

旁证：README 排障里那条 `attach failed: Cannot access a chrome-extension:// URL` 是 `chrome.debugger.attach` 的典型报错；同时它提供 `OPENCLI_CDP_ENDPOINT` / `OPENCLI_CDP_TARGET`，说明**双通道**：默认走扩展桥，需要时可直连 CDP（无头/CI 用这条）。

**"原语"的真实来源**：所谓 `click` / `type` / `extract` / `state`，都是对 CDP 域的二次封装——`state` 产出的是**精简 DOM / 可交互元素快照 + ref 编号**（不是截图），所以 token 友好；`extract` 走 readability 类抽取；`network --static` 用 `Network.*` 记录。

**给我们的安全启示**：daemon 只听 `localhost` + 一个自定义请求头，等价于"本机任意进程可调用"。我们自研后端时要加**随机端口 + token + 仅 127.0.0.1（或 unix socket）**，扩展的 `host_permissions` 也要按域名白名单最小化。

**一次 `click` 的完整往返（示意，非官方实现细节）**

```
用户：opencli browser click --ref 12 --session work
 ① CLI  → daemon   POST /command   {action:"click", ref:12, session:"work"}
 ② daemon → 扩展   WS   {id, method:"click", sessionId:<targetId>, ref:12}
 ③ 扩展            Runtime.evaluate 定位 ref=12 的节点 → 取 box model
                   Input.dispatchMouseEvent(mousePressed / mouseReleased)  ← 真事件
 ④ 扩展 → daemon   {ok:true, data:{clicked:true}}
 ⑤ daemon → CLI    stdout {"ok":true,"data":{...}}；退出码 0
```

关键在 ③：真正落点的是 **CDP 的 `Input` 域**（浏览器级真实输入），不是脚本 `element.click()`。这是它比"注入 JS 点击"更可靠的原因。

**进程生命周期与接入方式（决定我们怎么接）**

| 进程 | 生命期 | 角色 |
|---|---|---|
| Agent / 宿主 | 长（会话级） | 发起工具调用 |
| `opencli` CLI | **短**（一条命令，几十 ms ~ 数秒） | 无状态前端：解析参数 → 转发给 daemon → 打印 JSON → 退出 |
| daemon | 长（按需自动拉起，闲置退出） | 有状态后端：持有到扩展的 WS、租约、tab 绑定、slot 池、日志 |
| 扩展 service worker | 随 Chrome | 页面操作的实际执行者 |

- **CLI 是"工具的实现体"，不是工具本身**：`ITool.handler` 里 `spawn('opencli', [...])` 是它的用法之一，不是唯一用法。
- 两种接入方式：

| 方式 | 优点 | 代价 |
|---|---|---|
| **spawn CLI（默认）** | 简单、进程隔离、直接复用上游 100+ 站点命令与 skill 文档 | 每次多一次进程创建（约 50–100ms）+ JSON 解析 |
| **Agent 内嵌 client 直连 daemon** | 省一次进程；能拿事件流；便于预算与审计 | 要自己维护 daemon 协议与重连 |

建议：先用 spawn 打通；延迟敏感或需要事件流时再内嵌 client。中间那层 daemon 是"有状态"的根源——短命的 CLI 进程存不住 WS 与租约，这也是它必须存在的理由。

## 2.2 CDP 基础（理解 OpenCLI、也为自研后端铺路）

### 是什么

**Chrome DevTools Protocol**：Chrome 的远程控制协议。它是浏览器内部调试通道的对外暴露——你按 F12 打开的 DevTools，自己就是一个 CDP 客户端。所以它**不是为自动化专门设计的接口**，能力边界比 WebDriver 宽得多。

### 连接三步

```
① HTTP 发现   GET http://127.0.0.1:9222/json/version     # 浏览器信息
               GET http://127.0.0.1:9222/json/list        # 有哪些 tab / target
② WebSocket    ws://127.0.0.1:9222/devtools/page/<targetId>
③ JSON 收发    请求-响应 + 事件推送
```

### 消息模型

```json
→ {"id":1,"method":"Page.navigate","params":{"url":"https://example.com"}}
← {"id":1,"result":{"frameId":"A1B2..."}}

← {"method":"Page.loadEventFired","params":{"timestamp":1234.5}}   // 事件：无 id
```

要点：**请求带 `id`、响应回同一个 `id`；事件没有 `id`，由浏览器主动推**。所以它同时是 RPC 和事件流。

### 常用域

| 域 | 能力 |
|---|---|
| `Page` | 导航、生命周期事件、`captureScreenshot`、导出 PDF |
| `Runtime` | 页面内执行 JS（`evaluate`）、读返回值、订阅 console |
| `DOM` / `DOMSnapshot` | 查询或修改节点树、取精简快照 |
| `Input` | 派发**真实**鼠标/键盘事件 |
| `Network` | 请求拦截、响应读取、改头、导 HAR |
| `Target` | 管理 tab / iframe / worker（`setAutoAttach` + flatten） |
| `Emulation` | UA、视口、地理、网络限速 |
| `Storage` / `Fetch` | Cookie、缓存、请求劫持 |

### 两个容易忽略的点

1. **`Runtime.evaluate("btn.click()")` ≠ `Input.dispatchMouseEvent`**：前者是脚本点击，事件 `isTrusted = false`，风控与部分框架能识别；后者是浏览器级真实输入。自动化可靠性的差距主要在这里，OpenCLI 的 `click` 走的是后者。
2. **flatten 模式**：`Target.setAutoAttach{flatten:true}` 之后所有子 target 复用同一条 WebSocket，用 `sessionId` 区分——多 tab、iframe 不用开多条连接。

### 谁在用

| 工具 | 关系 |
|---|---|
| Chrome DevTools 本体 | 就是 CDP 客户端 |
| Puppeteer | 直连 CDP |
| Playwright | 自研封装（并逐步抽象为跨浏览器协议） |
| OpenCLI 扩展 | `chrome.debugger` 底层即 CDP，扩展作代理 |
| Selenium 4 | WebDriver 之外也支持 CDP（仅 Chromium） |

结论：Puppeteer / Playwright 并不"比 CDP 更强"，它们是 CDP 的**上层抽象**。

### 代价

| 代价 | 说明 |
|---|---|
| 非标准 | Chromium 私有协议，Firefox / Safari 不通（WebDriver 才是标准） |
| 版本漂移 | 域与参数随 Chrome 版本演进，实验性接口会变 |
| 权限等于全控 | 能读页面、读 Cookie、改请求 —— 通道泄露即浏览器被接管 |
| 默认 profile 受限 | Chrome 对默认用户目录开放远程调试有限制，这正是扩展路线存在的原因 |

### 谁启动 CDP？（常见误解）

- **CDP 不是进程，也不是客户端程序**：它是**协议规范** + **Chrome 内建的服务端实现**。F12 DevTools 只是它的一个内置客户端。
- 服务端**由 Chrome 启动**，且**只有带 `--remote-debugging-port` / `--remote-debugging-pipe` 时才对外开放**。没有这个参数，浏览器内部仍有调试通道供 DevTools 使用，但外部连不上。
- 因此正确链路是：**Agent 启动"带 CDP 的 Chrome"**，而不是"启动 CDP"。Agent 全程是客户端。

| 角色 | 是 | 不是 |
|---|---|---|
| Chrome（browser process） | **CDP 服务端** | 不是被动被控对象 |
| Agent / Puppeteer / Playwright | **CDP 客户端** | 不是服务端 |
| DevTools（F12） | CDP 的**内置客户端** | 不是服务端 |
| CDP | **协议** | 不是进程 / 程序 |

**Chrome 的三种启动形态**

| 形态 | 谁起 Chrome | 端口 | 登录态 | 适用 |
|---|---|---|---|---|
| 自管实例 | Agent `spawn` | `--remote-debugging-port=0`，从 `DevToolsActivePort` 读 | 新 profile，**无登录态** | CI / 无头 / 确定性回放 |
| 复用日常 Chrome | 用户手动带参数启动 | 固定端口 | **有** | 需登录态，但要用户配合重启 |
| 扩展桥（OpenCLI 默认） | 用户日常启动，**无需参数** | 不开端口 | **有** | 日常桌面使用 |

`--remote-debugging-port=0` 的含义：让系统分配随机端口，Chrome 启动后把实际端口与 ws 路径写进 `--user-data-dir` 下的 `DevToolsActivePort` 文件（首行端口，次行路径），客户端读文件即可拿到端点，不用猜端口。

**安全**：开 debugging port 等于本机任何进程都能控制浏览器。须绑 `127.0.0.1`、随机端口、独立 profile、用完即关；更严的方式是 `--remote-debugging-pipe`（走 stdin/stdout 管道，不监听 TCP）。

### Chrome 为什么是多进程；端口只有一个

**直连 CDP = 连 browser process**（不是"连协议"）。CDP 服务端就实现在这个进程里，它是**控制面**；真正干活的是各个 renderer，属**数据面**，两者靠 Mojo IPC 转发。

```
Chrome 进程树
├─ browser process          ← CDP server 在这；唯一对外 TCP 端口
│    HTTP  /json/version, /json/list
│    WS    ws://127.0.0.1:PORT/devtools/browser/<browserId>
│           └─ 每条命令带 sessionId，路由到对应 target
├─ renderer (tab A)         ← Blink + V8，实际执行 DOM/JS
├─ renderer (tab B)
├─ renderer (跨站 iframe)    ← site isolation：不同站点不共享进程
├─ renderer (扩展 service worker)
├─ GPU process
└─ utility processes        ← 网络、音频、存储、PDF…
```

**所以只有一个端口，不是每 tab 一个：**

- `/json/list` 返回多个 target，每个 target 有各自的 ws **path**，但 `host:port` 是同一个；
- 现代做法是 `Target.setAutoAttach{flatten:true}`，**一条 WebSocket 连接**用 `sessionId` 多路复用所有 tab / iframe / worker；
- 用 `--remote-debugging-pipe` 时连端口都没有，走 stdin/stdout fd。

**多进程带来的两个实现注意点**

1. **renderer 崩溃 ≠ 连接断开**：browser process 还活着，只是某个 target 消失。工具层要监听 `Target.targetDestroyed`，把对应租约标记失效并可重建。
2. **资源控制靠 target 数**：每个 tab 一个 renderer（约几十~几百 MB）。并发抓取要限制同时存在的 target 数量，否则内存先炸。

**安全含义再强调一次**：一个端口控制全部 target——端口一旦被本机其他进程发现，等于整个浏览器（含所有已登录站点）被接管。

### 一次点击的 CDP 报文（可直接照抄）

**连接是 WebSocket 长连接**：一次 HTTP Upgrade 握手后复用，收发的是大量 JSON 文本帧，直到显式关闭。

```
ws://127.0.0.1:<port>/devtools/browser/<browserId>
```

**① attach 到目标页（拿 sessionId）**

```json
{"id":1,"method":"Target.attachToTarget","params":{"targetId":"ABC123","flatten":true}}
← {"id":1,"result":{"sessionId":"S1"}}
```

**② 开域（按需）**

```json
{"id":2,"sessionId":"S1","method":"Page.enable"}
{"id":3,"sessionId":"S1","method":"Runtime.enable"}
```

**③ 取按钮中心坐标（视口 CSS px）**

```json
{"id":4,"sessionId":"S1","method":"Runtime.evaluate","params":{
  "expression":"(()=>{const b=document.querySelector('#submit');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  "returnByValue":true}}
← {"id":4,"result":{"result":{"value":{"x":420,"y":180}}}}
```

（另一条路：`DOM.getDocument` → `DOM.querySelector` → `DOM.getBoxModel`，拿 quad 再算中心。）

**④ 派发真实鼠标事件（move → press → release，缺一不可）**

```json
{"id":5,"sessionId":"S1","method":"Input.dispatchMouseEvent","params":{"type":"mouseMoved","x":420,"y":180}}
{"id":6,"sessionId":"S1","method":"Input.dispatchMouseEvent","params":{"type":"mousePressed","x":420,"y":180,"button":"left","clickCount":1}}
{"id":7,"sessionId":"S1","method":"Input.dispatchMouseEvent","params":{"type":"mouseReleased","x":420,"y":180,"button":"left","clickCount":1}}
```

**⑤ 等页面事件**

```json
← {"sessionId":"S1","method":"Page.frameNavigated","params":{"frame":{"url":"https://..."}}}
← {"sessionId":"S1","method":"Page.loadEventFired","params":{"timestamp":1234.5}}
```

**踩坑清单**

| 坑 | 说明 |
|---|---|
| 坐标系 | `Input` 用**视口坐标**（CSS px），不是文档坐标；滚动或缩放后必须重算 |
| 事件配对 | `mousePressed` 后必须 `mouseReleased`，否则页面卡在按下态；`button` 与 `clickCount` 必填 |
| 悬浮态 | 二级菜单需要先 `mouseMoved` 并等一帧，再点 |
| 双击 | 连续两次 press/release，第二次 `clickCount:2` |
| 元素不可见 | 先 `scrollIntoView`，或算坐标时排除 `display:none` / 被遮挡 |
| 事件混淆 | 用 `Input`（`isTrusted:true`）而不是 `Runtime.evaluate("el.click()")` |
| 响应匹配 | 客户端要维护 `id → Promise` 映射；事件无 `id`，按 `method` + `sessionId` 分发 |

### 多标签页：发现、attach、监听

**F12 只盯一个页面，是 UI 限制，不是协议限制。** CDP 有两个级别的端点：

| 端点 | 范围 | 适用 |
|---|---|---|
| `/devtools/browser/<browserId>` | 整个浏览器 | 列 / 建 / 关 target，多路复用所有页面 |
| `/devtools/page/<targetId>` | 单个页面 | 简单，但一次只能一个，多 tab 要开多条连接 |

直连推荐 **browser 级 + `flatten:true`**：一条连接管所有页面。

**发现现有标签页**

```json
{"id":1,"method":"Target.getTargets"}
← {"id":1,"result":{"targetInfos":[
   {"targetId":"A1","type":"page","title":"掘金","url":"https://juejin.cn","attached":false},
   {"targetId":"A2","type":"page","title":"新标签页","url":"chrome://newtab/","attached":false},
   {"targetId":"A3","type":"service_worker","url":"chrome-extension://..."}]}}
```

字段要点：`type`（`page` / `iframe` / `worker` / `service_worker`）、`attached`（是否已被别人 attach）、`browserContextId`（区分普通、无痕、隔离上下文）。

**新开标签页并接管**

```json
{"id":2,"method":"Target.createTarget","params":{"url":"https://example.com"}}
← {"id":2,"result":{"targetId":"B1"}}
{"id":3,"method":"Target.attachToTarget","params":{"targetId":"B1","flatten":true}}
← {"id":3,"result":{"sessionId":"S2"}}
```

**监听"用户或页面新开了标签页"（关键）**

```json
// 必须在 browser 级连接上开
{"id":4,"method":"Target.setAutoAttach","params":{
   "autoAttach":true, "waitForDebuggerOnStart":false, "flatten":true,
   "filter":[{"type":"page"}]}}
← {"method":"Target.attachedToTarget","params":{
     "sessionId":"S3",
     "targetInfo":{"targetId":"C1","type":"page","url":"https://..."},
     "waitingForDebugger":false}}
```

| 手段 | 给你什么 | 适用 |
|---|---|---|
| `Target.setDiscoverTargets{discover:true}` | `targetCreated` / `targetDestroyed` / `targetInfoChanged` 事件 | 纯观察 |
| `Target.setAutoAttach{...flatten:true}` | 直接给 `sessionId` | 新 target 立刻可用 |

**四个坑**

| 坑 | 说明 |
|---|---|
| **层级搞错** | `setAutoAttach` 开在 **browser 级**才能捕获新 tab；开在 page 级只能捕获该页的 iframe / worker |
| **事件刷屏** | 不加 `filter` 会把 iframe、worker、扩展 SW 全推上来，必须按 `type` 过滤 |
| **sessionId 不稳定** | 每次 attach 都换；稳定标识是 `targetId`，业务侧用它做键 |
| **跨站导航换 session** | process swap 会触发 `Target.detachedFromTarget`，需要重新 attach；顶层 `targetId` 通常不变 |

**接管策略：三种开页方式，按场景选**

| 策略 | 做法 | 登录态 | 页面运行态 | 干扰用户 |
|---|---|---|---|---|
| **A 自开** | `Target.createTarget{url}` | 同 profile 时**有**（cookie 共享） | 无 | 无 |
| **B 接管现有** | `attachToTarget` 用户当前 tab | 有 | **完整保留** | 需用户配合 |
| **C 新开同 URL** | `createTarget` 用用户当前页的 URL | 有 | 无（除非 URL 自带步骤参数） | 无 |

**关键区分**：登录态在 profile 里（cookie / localStorage），**新标签页天然共享**；丢的是"**页面运行态**"——SPA 路由、半填的表单、向导第 5 步、购物车前端状态、滚动位置。

所以判断标准很干脆：

- 只是"需要登录" → **自开就行**，没必要接管；
- "已经填了一半 / 走到第 5 步 / 选中了一堆筛选条件" → **必须接管**，否则用户的准备全白费。

**接管契约（实现要点）**

1. **显式发起**：工具默认 `tab: "new"`；只有用户说"用我现在这个页面"或点"接管当前标签页"，才切 `tab: "current"`（或指定 `targetId`）。
2. **一次性确认**：接管前提示"将操作【标签页标题】，期间请勿切换或关闭"，并给出取消。
3. **独占租约**：同一 tab 同时只能被一个 run attach；冲突则排队或拒绝，绝不并发点击。
4. **变更感知**：监听 `Target.targetDestroyed`（被关闭）、`Target.detachedFromTarget`、以及注入脚本上报的 `visibilitychange`（被切走）→ **暂停并告知**，而不是继续盲点。
5. **归还规则**：接管的 tab 结束只 `detach`，**不 close**；自开的 tab 按策略关闭（默认关，可 `--keep-tab`）。
6. **不越界**：接管 ≠ 免审批。提交、支付、删除类动作仍走 Security 判定。

### 对自研后端的落点

```
启动 Chrome（独立 profile，--remote-debugging-port=0）
  → 读 profile 目录里的 DevToolsActivePort 拿实际端口（随机、不冲突、不用猜）
  → HTTP /json/list 取 target
  → WebSocket 连接，开 flatten 做多 tab
  → 用 Input / Page / Runtime 实现 open / click / type / extract / screenshot
```

优先 `Input` 域做交互（真实事件），`Runtime.evaluate` 只用于取值与轻量 DOM 查询，`state` 这类快照走 `DOMSnapshot` 而非截图。

## 2.3 登录墙处理：只停不登（对齐 PRD D18）

**与 OpenCLI 的关键差异**：它借用用户已登录的 profile，几乎不碰登录；我们 spawn 独立 profile，第一次必然撞上登录墙。策略定死：**Agent 永不代登录，停下等人。**

理由：代登录必然要碰账号密码与验证码（凭据入模型）；站点风控对人工登录宽容得多；登录失败的责任边界无法界定。

### 检测（任一信号命中即暂停）

| 信号 | 判定方式 | 强度 |
|---|---|---|
| 密码框 | `document.querySelector('input[type=password]')` | 最强 |
| URL / 标题 | 正则 `login|signin|signin|auth|sso|登录|扫码` | 强 |
| 状态码 | 401 / 403 且发生跳转 | 强 |
| 验证码容器 | `captcha` / `slider` / `geetest` / `nc_1_wrapper` | 直接停 |
| 文案兜底 | 预期元素缺失 + "请先登录 / 未登录" | 兜底 |

**误判防护**

- 用**组合信号**（密码框 + 无已登录标志），不单看 URL；
- 站点级 override 表：允许把"设置页里的改密码表单"标为白名单，避免误停；
- 检测放在**每个 step 执行前后各一次**——导航后才暴露登录页是常态。

### 中断与恢复

```
step 前/后检测命中
  → 抛出 auth.required 事件（不静默失败）
  → 暂停 plan，已完成 step 保留（每步幂等标记）
  → 窗口置前；无头则切有头（无 GUI 环境直接报错，不硬跑）
  → 壳提示：「请在窗口中完成 登录（站点名），完成后点继续」
  → 等待：密码框消失 / URL 变化 / 用户菜单出现 / 用户点「继续」
  → 超时 10 分钟 → 事件流写 auth.timeout，任务转 blocked（waiting_on=用户本人）
  → 恢复后从断点续跑
```

### 实现要点

| 要点 | 做法 |
|---|---|
| **快照脱敏** | `DOMSnapshot` / `state` 生成时**排除 `input[type=password]` 的 value**，并跳过 `autocomplete=current-password` 字段；绝不把用户输入的密码带进上下文 |
| 状态映射 | 等人工登录 = `blocked`（等待对象=用户本人）；超时未处理 → 转 `paused`（`pause_reason=missing_input`） |
| 提醒 | 走 blocked 的递增曲线（2→3→5 天），文案是"该登录了"而非"该催对方了" |
| 统计 | 记 `auth.gate{site, signal, ts, resolved_by}`——用来找出"最常需要人工登录的站点"，决定是否要为它单独开扩展后端 |
| 多站点 | 一次任务可能连过多个站点，逐个停、逐个恢复，不合并提示 |

### 反模式（明确禁止）

- 自动填账号密码、勾"记住我"、点"下次自动登录"
- 处理或"智能识别"验证码（滑块、点选、短信）
- 复制用户日常浏览器的 Cookie / 导出 storageState 搬到别的环境
- 无头模式下静默跳过登录直接失败，却不告诉用户原因
- 把密码框的值写进日志、事件流或快照

## 3. 值得借鉴的四点（已并入 05-tools）

1. **原语 / 适配器分层**：`browser` toolset 只对外暴露少量稳定原语，站点能力做成可插拔件，进 Plugin/MCP 通道，不进内核。对应"Toolset 命名包"与"Everything is a plugin"。
2. **工具结果契约**：`{ok,data} | {ok,error{code,message,hint}}` + stderr 分离 + 语义化退出码，可直接作为 `IToolRunner.run()` 的返回约定。
3. **租约与回收是一等设计点**：浏览器是有状态稀缺资源。需要"独占租约 + 空闲回收 + 显式释放"；`05-tools` 原稿只提了超时与错误处理，缺这一块（与子代理并行时尤其关键）。
4. **"写适配器"属技能**：recon→init→test 这套流程是技能而非内核能力，归 `06-skills`。

## 4. 不引入的理由

| 理由 | 说明 |
|---|---|
| 环境强绑定 | 依赖桌面版 Chrome + 扩展 + 本机 daemon（19825），服务器/CI 基本不可用，与 `IExecutionBackend`（local/docker/ssh/cloud）可插拔冲突 |
| 权限放大 | 借用户登录态 = 借用户全部账号权限；站点白名单与写操作审批必须由 `08-security` 前置拦截，不能指望适配器自律 |
| 供应链 | npm 包 `postinstall` 会拉取 adapters 脚本，面偏大，引入需安全审查 |
| 已知缺陷 | site slot `poolSize > 1` 时依赖渲染的懒加载命令会卡住；部分清理动作依赖新版扩展 |

## 5. 结论（落点）

- **不作为依赖引入内核**；定位为"参考实现 + 可选外部能力"，可经 MCP 挂载。
- `browser` 原语**自研**：CDP 直连，Playwright 作可选后端。
- 站点适配层走**插件**，不占内核体积。
- 契约与租约模型按 §3 的 1–3 点执行。

## 6. 与当前 PRD 的关系

任务助手 M1 不做浏览器工具（不在范围内）；此备忘服务于 `05-tools` 的浏览器 toolset 详细设计，等 M2 之后再排期。

## 7. 作为预装能力的定位（2026-11-05 追加）

它确实是 skill 形态——上游自己就以 `npx skills add jackwener/opencli` 分发 4 个 skill（`opencli-browser` / `-adapter-author` / `-autofix` / `-usage`），skill 只教模型怎么用那个 CLI。所以"能不能作为我们预装的东西"要拆成三件事分别决定：

| 预装什么 | 成本 | 建议 |
|---|---|---|
| **SKILL.md（文本）** | 几乎为零，随仓库分发 | **预装**：`skills/browser-opencli/`，教模型用命令 + 何时改用自研后端 |
| **CLI 二进制（npm 包）** | 体积、Node 版本、平台差异、`postinstall` 拉取脚本 | **不预装**，首次使用时按需安装并提示 |
| **Chrome 扩展 + daemon** | 必须用户手动去商店装、daemon 占端口、需要桌面环境 | **不能替用户装**，只能引导 + 探测 |

**定位：`bundled but disabled`（内置但默认关闭）。**

1. 技能随包分发，不启用时不占任何运行成本；
2. 首次需要浏览器能力时做 **capability probe**：`opencli` 是否存在 → 桥是否连通（`opencli doctor`）→ 扩展是否装好；
3. 探测失败不报错，降级为"提示如何启用"或走自研 CDP 后端；
4. 启用后同时挂一个 **tool provider 插件**（把常用原语包装成原生工具），统一拿到结果契约、审批点、预算与审计；只有 skill 时模型走 shell 调 CLI，可审计性差一档。

**两梯队路由**（Runtime 决定用哪个）：

| 环境 | 选谁 | 理由 |
|---|---|---|
| 桌面 + 已登录 Chrome + 需要站点适配器 | **OpenCLI** | 零成本，100+ 站点命令现成，借登录态 |
| 无头 / 服务器 / CI / 需要确定性回放 | **自研 CDP（Playwright 可选）** | 可控、可并行、无扩展依赖 |

**预装的三个真实代价**（必须写进启用说明，不能藏）：

1. **版本漂移吃进我们的发版**：上游 2.x 仍在改命令语法（`analyze`/`discover` 已被 `state --diagnostics`/`network --static` 取代），预装等于把破坏性变更接进我们的节奏。
2. **权限面放大**：借用登录态 = 已登录账号 + 任意站点的写权限。必须域名白名单 + 写操作审批，默认只读。
3. **供应链**：`postinstall` 会拉取 adapters 脚本，需在启用前做一次审查与版本锁定。

**结论**：作为**预装 skill + 可选插件**成立；作为**默认启用能力**不成立。默认关闭，能力探测后按需开启，并用自研后端兜住无头场景。
