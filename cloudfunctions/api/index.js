const cloud = require("wx-server-sdk");
const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const C = { meetings:"meetings", segments:"audioSegments", jobs:"processingJobs", configs:"providerConfigs", invites:"invitedUsers" };
const ok = data => ({ ok:true, data });
const fail = (message, code="BAD_REQUEST") => ({ ok:false, error:{code,message} });
const now = () => db.serverDate();
const openid = () => cloud.getWXContext().OPENID;
const sharedMode = () => process.env.PROVIDER_MODE === "shared";

function sharedProviderConfig() {
  const transcription = {
    provider:"tencent", appId:String(process.env.TENCENT_APP_ID||"").trim(),
    apiKey:String(process.env.TENCENT_SECRET_ID||"").trim(), apiSecret:String(process.env.TENCENT_SECRET_KEY||""),
    region:String(process.env.TENCENT_REGION||"ap-guangzhou"), model:String(process.env.TENCENT_ASR_MODEL||"16k_zh")
  };
  const summary = {
    provider:"openai-compatible", baseUrl:String(process.env.SUMMARY_BASE_URL||"https://api.deepseek.com").replace(/\/$/,""),
    apiKey:String(process.env.SUMMARY_API_KEY||""), model:String(process.env.SUMMARY_MODEL||"deepseek-v4-flash")
  };
  if(!transcription.appId||!transcription.apiKey||!transcription.apiSecret||!summary.apiKey) throw new Error("管理员尚未完成统一模型配置");
  return {transcription,summary};
}
async function providerConfigFor(user) {
  if(sharedMode()) return {source:"environment",config:sharedProviderConfig()};
  const row=(await db.collection(C.configs).where({openid:user}).limit(1).get()).data[0];
  if(!row) throw new Error("请先在设置页配置转写和总结接口");
  return {source:"user",config:decrypt(row.encrypted),encrypted:row.encrypted};
}

async function authorize(user) {
  if (process.env.INVITE_MODE !== "on") return;
  const hit = await db.collection(C.invites).where({ openid:user, enabled:true }).limit(1).get();
  if (!hit.data.length) throw new Error("当前微信尚未加入体验名单");
}
async function ownMeeting(id, user) {
  const r = await db.collection(C.meetings).doc(id).get();
  if (!r.data || r.data.openid !== user) throw new Error("会议不存在或无权访问");
  return r.data;
}
function secretKey() {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw || raw.length < 24) throw new Error("云函数未配置 CONFIG_ENCRYPTION_KEY");
  return crypto.createHash("sha256").update(raw).digest();
}
function encrypt(value) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv("aes-256-gcm",secretKey(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return { version:1, iv:iv.toString("base64"), tag:cipher.getAuthTag().toString("base64"), data:encrypted.toString("base64") };
}
function decrypt(value) {
  const decipher=crypto.createDecipheriv("aes-256-gcm",secretKey(),Buffer.from(value.iv,"base64"));
  decipher.setAuthTag(Buffer.from(value.tag,"base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,"base64")),decipher.final()]).toString("utf8"));
}
function mask(config) {
  if(!config)return null;
  const x={...config}; delete x.apiKey; delete x.apiSecret; delete x.secretKey; delete x.secretId;
  x.hasKey=true; x.hasSecret=!!(config.apiSecret||config.secretKey); return x;
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n=ip.split(".").map(Number);
    return n[0]===10||n[0]===127||n[0]===0||(n[0]===169&&n[1]===254)||(n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&n[1]===168)||(n[0]>=224);
  }
  return ip==="::1"||ip.startsWith("fc")||ip.startsWith("fd")||ip.startsWith("fe80");
}
async function validateBaseUrl(value, provider) {
  if(provider==="tencent") return;
  const u=new URL(value);
  if(u.protocol!=="https:")throw new Error("API 地址必须使用 HTTPS");
  const records=await dns.lookup(u.hostname,{all:true});
  if(records.some(x=>isPrivateIp(x.address)))throw new Error("API 地址不能指向本机或内网");
}
async function testConfig(kind, config) {
  await validateBaseUrl(config.baseUrl, config.provider);
  if(config.provider==="tencent") {
    if(!(config.secretId||config.apiKey) || !(config.secretKey||config.apiSecret)) throw new Error("腾讯云需要 SecretId 和 SecretKey（分别填入 API Key 与模型旁的 SecretKey）");
    const sdk=require("tencentcloud-sdk-nodejs");
    const client=new sdk.asr.v20190614.Client({credential:{secretId:config.secretId||config.apiKey,secretKey:config.secretKey||config.apiSecret},region:config.region||"ap-guangzhou",profile:{httpProfile:{endpoint:"asr.tencentcloudapi.com"}}});
    try { await client.DescribeTaskStatus({TaskId:0}); }
    catch(e) {
      const code=String(e?.code||"");
      if(code.startsWith("AuthFailure") || code==="UnauthorizedOperation") throw e;
    }
    return { reachable:true };
  }
  if(!config.apiKey) throw new Error("请输入 API Key");
  const base=config.baseUrl.replace(/\/$/,"");
  await axios.get(`${base}/models`,{headers:{Authorization:`Bearer ${config.apiKey}`},timeout:10000,maxContentLength:1024*1024});
  return { reachable:true };
}
async function kickProcessor() {
  try {
    await cloud.callFunction({name:"processor",data:{source:"recording-finished"}});
    return true;
  } catch(e) {
    console.error("immediate processor invoke failed",{message:e.message});
    return false;
  }
}
function realtimeUrl(config, voiceId) {
  const appId=String(config.appId||"").trim();
  const secretId=String(config.apiKey||config.secretId||"").trim();
  const secret=String(config.apiSecret||config.secretKey||"");
  if(!appId||!secretId||!secret)throw new Error("实时转写需要腾讯云 AppID、SecretId 和 SecretKey");
  const timestamp=Math.floor(Date.now()/1000),expired=timestamp+900;
  const params={engine_model_type:config.model||"16k_zh",expired,filter_empty_result:1,needvad:1,nonce:crypto.randomInt(100000,999999999),secretid:secretId,timestamp,vad_silence_time:1000,voice_format:8,voice_id:voiceId};
  const query=Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join("&");
  const origin=`asr.cloud.tencent.com/asr/v2/${appId}?${query}`;
  const signature=crypto.createHmac("sha1",secret).update(origin).digest("base64");
  return {url:`wss://asr.cloud.tencent.com/asr/v2/${appId}?${query}&signature=${encodeURIComponent(signature)}`,expiresAt:expired};
}
function realtimeTranscript(value) {
  const text=String(value?.text||"").trim().slice(0,300000);
  if(!text)return null;
  const segments=Array.isArray(value?.segments)?value.segments.slice(0,5000).map(x=>({start:Number(x?.start)||0,end:Number(x?.end)||0,speaker:null,text:String(x?.text||"").slice(0,5000)})).filter(x=>x.text):[];
  return {text,segments};
}
async function writeTranscript(ref,meeting,transcript,status) {
  if(meeting.transcript===null)await ref.update({data:{transcript:_.remove()}});
  await ref.update({data:{transcript,status,updatedAt:now()}});
}

const handlers = {
  async createMeeting(p,user) {
    const r=await db.collection(C.meetings).add({data:{openid:user,title:String(p.title||"未命名会议").slice(0,80),mainIdea:"",duration:0,status:"uploading",createdAt:now(),updatedAt:now()}});
    return {meetingId:r._id};
  },
  async registerSegment(p,user) {
    await ownMeeting(p.meetingId,user);
    const existing=await db.collection(C.segments).where({openid:user,meetingId:p.meetingId,index:Number(p.index)}).limit(1).get();
    if(existing.data.length)return {segmentId:existing.data[0]._id,duplicate:true};
    const r=await db.collection(C.segments).add({data:{openid:user,meetingId:p.meetingId,index:Number(p.index),fileId:p.fileId,duration:Number(p.duration)||0,createdAt:now()}});
    return {segmentId:r._id};
  },
  async createRealtimeSession(p,user) {
    const meeting=await ownMeeting(p.meetingId,user);
    const transcription=(await providerConfigFor(user)).config.transcription;
    if(transcription.provider!=="tencent")throw new Error("实时转写当前需要选择腾讯云语音识别");
    const voiceId=String(p.voiceId||crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g,"").slice(0,128);
    if(!voiceId)throw new Error("无效的实时转写会话");
    const signed=realtimeUrl(transcription,voiceId);
    await db.collection(C.meetings).doc(meeting._id).update({data:{realtimeStatus:"connecting",realtimeVoiceId:voiceId,updatedAt:now()}});
    return {...signed,voiceId};
  },
  async finishRecording(p,user) {
    const meeting=await ownMeeting(p.meetingId,user);
    const provider=await providerConfigFor(user);
    const transcript=realtimeTranscript(p.realtimeTranscript);
    const old=await db.collection(C.jobs).where({openid:user,meetingId:p.meetingId,status:_.neq("completed")}).limit(1).get();
    const stage=transcript?"summary":"transcription";
    if(!old.data.length)await db.collection(C.jobs).add({data:{openid:user,meetingId:p.meetingId,status:"queued",stage,segmentCursor:0,transcriptParts:[],configSource:provider.source,configSnapshot:provider.encrypted||null,retries:0,createdAt:now(),updatedAt:now()}});
    const ref=db.collection(C.meetings).doc(p.meetingId);
    if(transcript)await writeTranscript(ref,meeting,transcript,"summarizing");
    await ref.update({data:{duration:Number(p.duration)||0,status:transcript?"summarizing":"queued",realtimeStatus:transcript?"completed":"fallback",updatedAt:now()}});
    const started=await kickProcessor();
    return {queued:true,started,realtime:!!transcript};
  },
  async listMeetings(p,user) {
    const r=await db.collection(C.meetings).where({openid:user}).orderBy("createdAt","desc").limit(100).field({title:true,mainIdea:true,duration:true,status:true,createdAt:true}).get(); return r.data;
  },
  async getMeetingDetail(p,user) {
    const m=await ownMeeting(p.meetingId,user);
    const seg=await db.collection(C.segments).where({openid:user,meetingId:p.meetingId}).orderBy("index","asc").get();
    let audioUrls=[];
    if(seg.data.length){const r=await cloud.getTempFileURL({fileList:seg.data.map(x=>x.fileId)});audioUrls=r.fileList.map(x=>x.tempFileURL).filter(Boolean);}
    return {...m,audioUrl:audioUrls[0]||"",audioUrls};
  },
  async retryProcessing(p,user) {
    await ownMeeting(p.meetingId,user);
    const r=await db.collection(C.jobs).where({openid:user,meetingId:p.meetingId}).orderBy("createdAt","desc").limit(1).get();
    if(!r.data.length)throw new Error("没有可重试任务");
    const job=r.data[0]; await db.collection(C.jobs).doc(job._id).update({data:{status:"queued",error:null,retries:_.inc(1),updatedAt:now()}}); await db.collection(C.meetings).doc(p.meetingId).update({data:{status:job.stage==="summary"?"summarizing":"queued",errorMessage:"",updatedAt:now()}}); const started=await kickProcessor(); return {queued:true,started};
  },
  async regenerateSummary(p,user) {
    const m=await ownMeeting(p.meetingId,user);if(!m.transcript)throw new Error("暂无逐字稿");
    const provider=await providerConfigFor(user);
    await db.collection(C.jobs).add({data:{openid:user,meetingId:p.meetingId,status:"queued",stage:"summary",segmentCursor:0,transcriptParts:[],configSource:provider.source,configSnapshot:provider.encrypted||null,retries:0,createdAt:now(),updatedAt:now()}});await db.collection(C.meetings).doc(p.meetingId).update({data:{status:"summarizing",updatedAt:now()}});const started=await kickProcessor();return {queued:true,started};
  },
  async deleteMeeting(p,user) {
    await ownMeeting(p.meetingId,user);const seg=await db.collection(C.segments).where({openid:user,meetingId:p.meetingId}).get();if(seg.data.length)await cloud.deleteFile({fileList:seg.data.map(x=>x.fileId)});
    for(const name of [C.segments,C.jobs]){const rows=await db.collection(name).where({openid:user,meetingId:p.meetingId}).get();await Promise.all(rows.data.map(x=>db.collection(name).doc(x._id).remove()));}
    await db.collection(C.meetings).doc(p.meetingId).remove();return {deleted:true};
  },
  async saveProviderConfig(p,user) {
    if(sharedMode())throw new Error("当前为管理员统一配置，体验用户无需填写密钥");
    const previous=await db.collection(C.configs).where({openid:user}).limit(1).get();
    const old=previous.data[0]?.plainMask||{};
    const transcription={...p.transcription};const summary={...p.summary};
    const oldPlain=previous.data[0]?.encrypted?decrypt(previous.data[0].encrypted):null;
    if(!transcription.apiKey&&oldPlain?.transcription?.apiKey)transcription.apiKey=oldPlain.transcription.apiKey;
    if(!transcription.apiSecret&&oldPlain?.transcription?.apiSecret)transcription.apiSecret=oldPlain.transcription.apiSecret;
    if(!summary.apiKey&&oldPlain?.summary?.apiKey)summary.apiKey=oldPlain.summary.apiKey;
    if(!transcription.apiKey)throw new Error("请输入语音识别 API Key");
    if(transcription.provider==="tencent"&&!transcription.apiSecret)throw new Error("请输入腾讯云 SecretKey");
    if(transcription.provider==="tencent"&&!transcription.appId)throw new Error("请输入腾讯云 AppID，用于实时转写");
    if(!summary.apiKey)throw new Error("请输入总结 API Key");
    await validateBaseUrl(transcription.baseUrl,transcription.provider);await validateBaseUrl(summary.baseUrl,summary.provider);
    const encrypted=encrypt({transcription,summary}),plainMask={transcription:mask(transcription),summary:mask(summary)};
    if(previous.data.length)await db.collection(C.configs).doc(previous.data[0]._id).update({data:{encrypted,plainMask,updatedAt:now()}});else await db.collection(C.configs).add({data:{openid:user,encrypted,plainMask,createdAt:now(),updatedAt:now()}});
    return {saved:true};
  },
  async testProviderConfig(p){if(sharedMode())throw new Error("当前为管理员统一配置，请由管理员在云函数环境变量中维护");return testConfig(p.kind,p.config);},
  async getProviderConfigStatus(p,user) {if(sharedMode()){const cfg=sharedProviderConfig();return {shared:true,transcription:true,summary:true,transcriptionConfig:mask(cfg.transcription),summaryConfig:mask(cfg.summary)};}const r=await db.collection(C.configs).where({openid:user}).limit(1).get();const m=r.data[0]?.plainMask;return {shared:false,transcription:!!m?.transcription,summary:!!m?.summary,transcriptionConfig:mask(m?.transcription),summaryConfig:mask(m?.summary)};}
};

exports.main=async event=>{try{const user=openid();await authorize(user);const fn=handlers[event.action];if(!fn)return fail("未知操作","NOT_FOUND");return ok(await fn(event.payload||{},user));}catch(e){console.error("api failure",{action:event.action,message:e.message});return fail(e.message,e.code||"SERVER_ERROR");}};
