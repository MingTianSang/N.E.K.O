# 社区账户与远程实例访问边界（PR #3289 合并门槛）

维护者定论：项目自带首次连接授权，外置 nginx / NAS / VPN 鉴权可叠加。
本地桌面不增加步骤，不因转发头一律拒绝。远程连接权限与社区账户登录分别检查。
这是可信使用者共享实例的模型，不是各访客拥有隔离账户的多租户服务。

## 责任与体验

| 场景 | 只靠外置鉴权 | 本项目定论：自带保护，兼容网关 |
| --- | --- | --- |
| Docker 网页 | 部署者配置登录，覆盖全部 API/WS，禁止后端直连绕过 | 项目生成持久化 key，首次输入，刷新/重启复用会话 |
| Linux 直连 | 另装 VPN/认证网关 | 同一实例授权，传输使用 HTTPS/WSS |
| Windows Electron | 各窗口、主进程和 SSE 都接入网关 | 复用目的后端 Chromium session，后台请求经 Linux 固定 relay |
| 本机桌面/调试代理 | 不应增加步骤 | loopback PKCE、路径发现、真实回环客户端 XFF 兼容 |
| 未配置 nginx | 账户与其他接口可能直接暴露 | 匿名远程 API/WS 在读取账户、刷新或解析请求体前拒绝 |

已有网关仍需首次连接 NEKO。不信任 X-Authenticated-User、Origin、Host、CSRF 或自报
loopback XFF 来代替实例授权。部署者负责 HTTPS、持久化、key保管，不必为每个
Docker 域名注册 OAuth。所有启动入口仅信任127.0.0.1、::1的XFF，不受
FORWARDED_ALLOW_IPS影响；真实回环调试代理兼容，远程XFF不授予本机权限。
X-Real-IP/Forwarded-only与纯TCP隧道不能自动识别，须正确声明远程/代理部署并认证。

## 实例授权契约

主、memory、agent、插件服务共用 InstanceAccessMiddleware，覆盖 HTTP/WS。
只有本机 peer 与本机 Host 的正常原生调用免步骤。匿名响应不返回登录状态、昵称、
邮箱或ID；授权后的 /oauth/status 和 /auth-status 也不返回 Linux路径、社区令牌或verifier。
本机桌面的会话路径发现保留，Linux路径不能当Windows文件路径。

key默认在持久化根创建instance_access.key（POSIX0600），服务不输出秘密。
管理员显式执行 uv run python -m utils.instance_access 取得key。
Compose执行 docker compose exec --user neko -w /app neko-main uv run python -m utils.instance_access
（服务名按实际Compose）。多服务共享目录，或设置同一至少32字符的NEKO_INSTANCE_ACCESS_KEY。

首次同源表单验证10分钟challenge并限速，设置30天、绑定hostname的
HttpOnly/Secure/SameSite=Lax签名cookie。原生Bearer也仅通过HTTPS/WSS。
新请求即时重新验证key；现存SSE/WS按至多每秒一次检查文件key，配置key变更即时检查。
账户流同样至多每秒一次复核，避免语音帧/通知chunk触发逐帧文件读取。撤销延迟上限一秒。
临时IO错误做短时有限重试后仍失败则关闭，不永久使用旧key。
OAuth保存前重新检查连接授权；退出/新尝试取消旧pending，迟到回调不得复活账户。
实例身份不替代既有CSRF/来源检查。key/cookie不得写到URL、公共日志、PR或截图。

DNS域名使用既有NEKO_TRUSTED_HOSTS白名单；外置TLS网关必要时用NEKO_TRUSTED_ORIGINS声明该HTTPS origin。
HTTPS网关到私有HTTP上游应保留Host/协议；必要时设置NEKO_INSTANCE_PUBLIC_ORIGIN
为外部完整HTTPS origin并启用NEKO_BEHIND_PROXY。不从自报转发头推导认证。
同hostname不同端口共用cookie，须共享key；独立实例用不同hostname/key。

## OAuth回跳与发布依赖

本机保持loopback Desktop client。远程默认使用neko-servers-web-prod Web PKCE
client与认证平台自己的固定HTTPS /oauth/callback relay。项目平台注册一次；
普通Docker用户不必注册各自域名。Linux保留verifier，state包含实例origin和随机nonce。
relay不换令牌，只向opener精确origin发送一次性code/state；网页同时检查
event.origin、event.source、state，再向已授权Linux的/oauth/remote-callback提交。
Linux检查发起会话、state、PKCE和当前pending后保存凭证。
/oauth/completion?state=...只确认此客户端的本次尝试，旧全局logged_in不得误报成功。

远程Electron向当前后端提交一次性结果，不复制Linux文件或社区长期令牌。
通知/积分只代理固定已有端点，上游由服务器配置；账户切换/退出停止旧流。
自建平台可覆盖NEKO_COMMUNITY_WEB_CLIENT_ID。特殊直接后端回跳才配置
NEKO_COMMUNITY_WEB_REDIRECT_URI=https://后端/oauth/callback并精确注册；
默认留空用平台relay，不能动态接受任意redirect_uri。

发布顺序：认证平台relay及Web client注册 → Electron配套版本 → #3289。
配套未发布不能因CI绿色解除合并门槛，也不能把原403临时守卫当永久禁用Docker OAuth。

## 验收与用户测试

本地两个独立HTTPS测试域名、真实Chromium、生产实例授权/保存处理器、网页监听器、
平台relay已验证首次连接、PKCE换码、完成查询、cookie隔离、路径保护和重放拒绝。
测试调用生产navigateBrowserPopup、生产调用表达式和waitForOAuthCompletion，覆盖换码期间关闭弹窗。
浏览器保留空白预留窗口直到判定是否需要relay，仅固定relay保留opener，其他外部页面仍断开。
IdP/社区账号为隔离fixture；不等于生产平台或Linux/Windows实机验证。
运行 uv run python tests/frontend/run_remote_oauth_browser.py --auth-relay-module <编译后relay.js> --playwright-module <模块目录> --chrome <Chrome路径>。

用户无法提供后端，真实部署由用户/社区协助验收，不再要求维护者提供地址。
发布候选记录后端、PC、平台版本与以下结果：

1. 本机直接/调试代理登录、退出、切换账户、重启和路径发现。
2. Docker HTTPS及外置nginx首次连接、刷新/重启复用、OAuth回跳、退出重登；
   匿名窗口不能读账户/API/WS，自报认证头无效。
3. Linux后端+Windows Electron社区窗口、通知、积分、WS；切换实例不沿用旧凭证。
4. key轮换使旧通知/WS失效；取消、超时、退出、并发新登录不被旧回调复活。
5. 离线/上游暂不可用不误删账户，恢复可继续使用。
6. 回报版本、拓扑、步骤、状态码和结果，不提交key/cookie/code/verifier/token或完整账户响应。

单测、CI、真实浏览器fixture、真实部署验收分别记录。配套发布及用户验收未完成，
原Greptile线程保持open，#3289不宣称全部完成。

## 依据

已授权浏览器从站外链接打开 /、/chat、/subtitle 的顶层文档可复用会话；
账户 API、iframe、异源写操作仍拒绝。实际模型静态挂载采用 private 缓存，保留 ETag/max-age。
Market 的已授权内部服务转发使用短时 method/path 签名，并移除上一跳的转发元数据，
避免插件 Uvicorn 将真实回环服务调用误解析为公网客户端；Market Authorization 和来源头仍保留。
公开 HTTPS origin 同样绑定进签名，插件仅从已验证 scope 生成远程回调，不能信任调用者自报地址。
桌面原生 Market 不生成实例密钥；远程转发读完请求体再签发60秒证明，密钥错误返回503。
Market OAuth 的平台 client/redirect 注册仍遵循其独立协议，此回归不等于生产 Market 认证平台验收。
配对页只缓存八种语言的少量文案。共享代理 IP 的错误尝试仍限速，
正确密钥和有效 challenge 不受其他客户端错误次数影响。
回环调试代理 XFF 兼容仅适用于非代理桌面部署；代理部署的 capture 等本机资源
只允许无转发元数据的本机请求，不能通过配对获得服务器截图权限。

固定 relay 当前依赖 opener，整个 IdP 跳转链也会保留该引用。
尚未证明所有第三方认证页面隔离 opener；不得将 fixture 通过视为此风险已消除。
发布前需完成该跳转链审计或改为不依赖 opener 的完成传递。

- [nginx Basic Authentication](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)：location覆盖与后端隔离由部署者配置。
- [RFC8252 loopback回调](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)：loopback位于客户端，不能当远程Linux后端。
- [本地变更检查](/design/security/local-mutation-auth)：实例身份和CSRF分别校验。
