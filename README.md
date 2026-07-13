# 微信会议纪要小程序

面向少量受邀用户的微信原生 TypeScript 小程序。录音分段保存到微信云存储，结束后由后台任务自动转写并生成结构化会议纪要。

## 已实现

- 参考录音工具设计的首页、录音页、详情页和设置页
- 16 kHz 单声道 MP3、暂停/继续、约10分钟自动分段、最长60分钟保护
- 云存储上传、会议列表、状态轮询、失败重试、重新总结与删除
- OpenAI Transcription 兼容识别、腾讯云长语音识别、OpenAI兼容总结
- AES-256-GCM 加密 API 配置、`openid` 数据隔离和体验用户白名单
- 每分钟推进一次的后台处理任务

## 1. 当前项目配置

- AppID：`wx9ed761b2e83810a0`
- 云环境 ID：`cloud1-d1gn26yde8fd1f267`

两项已写入项目。接下来只需在微信开发者工具中部署云函数。

## 2. 初始化数据库

1. 右键 `cloudfunctions/setup`，选择“上传并部署：云端安装依赖”。
2. 部署成功后，在云开发控制台运行一次 `setup`。
3. 它会自动创建 `meetings`、`audioSegments`、`processingJobs`、`providerConfigs`、`invitedUsers`。
4. 对每个集合分别应用 `database.rules.json` 的规则；客户端不直接读写数据库。

## 3. 部署云函数

在开发者工具中依次右键 `cloudfunctions/setup`、`cloudfunctions/api` 和 `cloudfunctions/processor`，选择“上传并部署：云端安装依赖”。先在云端运行一次 `setup`，确认集合创建成功，再部署业务函数。

为两个云函数配置相同环境变量：

```text
CONFIG_ENCRYPTION_KEY=至少32位的随机字符串
INVITE_MODE=off
```

可用 PowerShell 生成主密钥（结果只填云函数环境变量）：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

初次调试使用 `INVITE_MODE=off`。之后改成 `on`，并在 `invitedUsers` 添加：

```json
{ "openid": "受邀用户的OPENID", "enabled": true }
```

## 4. 模型配置

进入小程序“接口设置”页面配置并测试。

OpenAI Transcription兼容识别需要 `GET /v1/models` 与 `POST /v1/audio/transcriptions`。腾讯云配置中 API Key 填 SecretId，SecretKey 单独填写。总结接口需要 `GET /v1/models` 与 `POST /v1/chat/completions`，并能返回 JSON。

## 5. 体验版

1. 在开发者工具点击“上传”。
2. 在微信公众平台把开发版本设置为体验版。
3. 添加体验成员并分享体验二维码。
4. 在隐私保护指引中声明麦克风、录音、云端存储和第三方AI处理用途。

## 重要限制

- 微信小程序不能在用户未点击的情况下静默开始录音。
- 处理器每分钟处理一个音频分段或总结任务，可通过并发任务扩容。
- 详情页会按录音分段顺序连续播放完整会议音频。
- 自定义接口必须为公网 HTTPS 地址，内网和本机地址会被拒绝。
- 不要把 AppSecret、模型密钥或 `CONFIG_ENCRYPTION_KEY` 写入仓库。

## 本地预检

安装 Node.js 后在项目根目录执行：

```powershell
npm run validate
```

该命令不会联网或修改文件，会检查 JSON、云函数语法、AppID、云环境 ID 和数据库集合定义。
