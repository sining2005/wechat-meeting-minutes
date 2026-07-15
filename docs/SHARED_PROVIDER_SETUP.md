# 统一模型配置（体验版）

启用后，体验用户不用填写或接触任何模型密钥。录音、逐字稿和纪要仍按各自的微信 `openid` 隔离。

在云函数 **api** 和 **processor** 中都添加完全相同的环境变量：

```text
PROVIDER_MODE=shared
TENCENT_APP_ID=腾讯云数字 AppID
TENCENT_SECRET_ID=腾讯云 SecretId
TENCENT_SECRET_KEY=腾讯云 SecretKey
TENCENT_REGION=ap-guangzhou
TENCENT_ASR_MODEL=16k_zh
TENCENT_REALTIME_MODEL=16k_zh_en_speaker
SUMMARY_BASE_URL=https://api.deepseek.com
SUMMARY_API_KEY=DeepSeek API Key
SUMMARY_MODEL=deepseek-v4-flash
```

不要把任何值写进小程序代码、项目文件或聊天信息。保存环境变量后，分别重新部署 `api` 和 `processor`（选择“云端安装依赖”）。

最后在小程序后台配置 Socket 合法域名：

```text
wss://asr.cloud.tencent.com
```

设置页显示“管理员统一配置已启用”即说明客户端已切换为统一配置模式。
