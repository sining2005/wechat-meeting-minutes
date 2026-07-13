const cloud=require("wx-server-sdk"),axios=require("axios"),FormData=require("form-data"),crypto=require("crypto");
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});const db=cloud.database();
const C={meetings:"meetings",segments:"audioSegments",jobs:"processingJobs"};
const now=()=>db.serverDate();
function sharedProviderConfig(){const transcription={provider:"tencent",appId:String(process.env.TENCENT_APP_ID||"").trim(),apiKey:String(process.env.TENCENT_SECRET_ID||"").trim(),apiSecret:String(process.env.TENCENT_SECRET_KEY||""),region:String(process.env.TENCENT_REGION||"ap-guangzhou"),model:String(process.env.TENCENT_ASR_MODEL||"16k_zh")};const summary={provider:"openai-compatible",baseUrl:String(process.env.SUMMARY_BASE_URL||"https://api.deepseek.com").replace(/\/$/,""),apiKey:String(process.env.SUMMARY_API_KEY||""),model:String(process.env.SUMMARY_MODEL||"deepseek-v4-flash")};if(!transcription.appId||!transcription.apiKey||!transcription.apiSecret||!summary.apiKey)throw new Error("管理员尚未完成统一模型配置");return {transcription,summary};}
function key(){const raw=process.env.CONFIG_ENCRYPTION_KEY;if(!raw||raw.length<24)throw new Error("未配置 CONFIG_ENCRYPTION_KEY");return crypto.createHash("sha256").update(raw).digest();}
function decrypt(v){const d=crypto.createDecipheriv("aes-256-gcm",key(),Buffer.from(v.iv,"base64"));d.setAuthTag(Buffer.from(v.tag,"base64"));return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data,"base64")),d.final()]).toString("utf8"));}
const prompt=`你是一名专业、严谨的会议纪要助手。请根据会议逐字稿生成结构化中文会议纪要。只能使用逐字稿明确出现的信息，不得虚构；不得猜测负责人、截止时间、人物身份、数字或结论，不明确时返回null；删除口头禅、重复内容、寒暄和明显识别噪声；保留重要人物、时间、数字、产品名称、决定、分歧和限制条件；区分已确定结论、行动事项、风险和待确认问题；标题8至20个汉字；一句话主旨30至50个汉字；没有真实姓名时不得推测临时说话人身份；仅返回合法JSON，不输出Markdown。JSON字段必须为 title,mainIdea,summary,topics,conclusions,actionItems,risks,pendingQuestions,minutes。topics项包含topic,discussion,result；actionItems项包含task,owner,deadline；minutes项包含topic,content。`;
function parseJson(text,transcriptText=""){const raw=String(text).trim();const clean=raw.replace(/^```(?:json)?\s*|\s*```$/gi,"").trim();let data;try{data=JSON.parse(clean);}catch(_){const first=clean.indexOf("{");const last=clean.lastIndexOf("}");if(first<0||last<=first)throw new Error("模型未返回可解析的 JSON");data=JSON.parse(clean.slice(first,last+1));}if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("模型未返回 JSON 对象");const source=String(transcriptText).replace(/\s+/g," ").trim();const valueText=v=>typeof v==="string"?v.trim():"";data.title=valueText(data.title)||"本次会议讨论纪要";data.mainIdea=valueText(data.mainIdea)||valueText(data.summary)||source.slice(0,50)||"已完成会议内容整理，请查看完整纪要。";data.summary=valueText(data.summary)||source||"未识别到可总结的有效发言内容。";for(const k of ["topics","conclusions","actionItems","risks","pendingQuestions","minutes"])if(!Array.isArray(data[k]))data[k]=[];console.log("summary parsed",{hasTitle:Boolean(valueText(data.title)),hasMainIdea:Boolean(valueText(data.mainIdea)),hasSummary:Boolean(valueText(data.summary)),rawLength:raw.length});return data;}
async function openaiTranscribe(config,fileId){const dl=await cloud.downloadFile({fileID:fileId});const form=new FormData();form.append("file",dl.fileContent,{filename:"segment.mp3",contentType:"audio/mpeg"});form.append("model",config.model);if(config.language)form.append("language",config.language);const base=config.baseUrl.replace(/\/$/,"");const r=await axios.post(`${base}/audio/transcriptions`,form,{headers:{...form.getHeaders(),Authorization:`Bearer ${config.apiKey}`},timeout:50000,maxContentLength:30*1024*1024,maxBodyLength:30*1024*1024});const text=r.data.text||"";return {text,segments:(r.data.segments||[]).map(x=>({start:x.start||0,end:x.end||0,speaker:x.speaker||null,text:x.text||""}))};}
async function tencentStep(config,job,segment){
  const sdk=require("tencentcloud-sdk-nodejs");const AsrClient=sdk.asr.v20190614.Client;const client=new AsrClient({credential:{secretId:config.apiKey||config.secretId,secretKey:config.apiSecret||config.secretKey},region:config.region||"ap-guangzhou",profile:{httpProfile:{endpoint:"asr.tencentcloudapi.com"}}});
  if(!job.externalTaskId){
    const file=await cloud.downloadFile({fileID:segment.fileId});
    const common={EngineModelType:config.model||"16k_zh",ChannelNum:1,ResTextFormat:3};
    let r;
    if(file.fileContent.length<=5*1024*1024){
      r=await client.CreateRecTask({...common,SourceType:1,Data:file.fileContent.toString("base64"),DataLen:file.fileContent.length});
      console.log("asr task submitted",{source:"body",bytes:file.fileContent.length});
    }else{
      const urls=await cloud.getTempFileURL({fileList:[segment.fileId]});
      r=await client.CreateRecTask({...common,SourceType:0,Url:urls.fileList[0].tempFileURL});
      console.log("asr task submitted",{source:"url",bytes:file.fileContent.length});
    }
    return {pending:true,externalTaskId:String(r.Data.TaskId)};
  }
  const r=await client.DescribeTaskStatus({TaskId:Number(job.externalTaskId)});
  console.log("asr task polled",{status:r.Data.Status,statusText:r.Data.StatusStr||"",audioDuration:r.Data.AudioDuration||0});
  if(r.Data.Status===0||r.Data.Status===1)return {pending:true};if(r.Data.Status!==2)throw new Error(r.Data.ErrorMsg||"腾讯云语音识别失败");const text=r.Data.Result||"";return {text,segments:[{start:0,end:segment.duration||0,speaker:null,text}]};
}
async function summarize(config,transcript){const base=config.baseUrl.replace(/\/$/,"");const body={model:config.model,messages:[{role:"system",content:prompt},{role:"user",content:`请总结以下会议逐字稿：\n\n${transcript.text}`}],response_format:{type:"json_object"},temperature:0.2};const options={headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json"},timeout:50000,maxContentLength:2*1024*1024};let r;try{r=await axios.post(`${base}/chat/completions`,body,options);}catch(e){if(e.response?.status!==400)throw e;const fallback={...body};delete fallback.response_format;r=await axios.post(`${base}/chat/completions`,fallback,options);}const message=r.data.choices?.[0]?.message||{};return parseJson(message.content||message.reasoning_content||"",transcript.text);}
async function processJob(job){const cfg=job.configSource==="environment"?sharedProviderConfig():decrypt(job.configSnapshot),mref=db.collection(C.meetings).doc(job.meetingId),jref=db.collection(C.jobs).doc(job._id);
  if(job.stage==="summary"){const m=(await mref.get()).data;if(!m.transcript)throw new Error("逐字稿不存在");await jref.update({data:{status:"running",updatedAt:now()}});await mref.update({data:{status:"summarizing",updatedAt:now()}});const summary=await summarize(cfg.summary,m.transcript);if(m.summary===null)await mref.update({data:{summary:_.remove()}});await mref.update({data:{title:summary.title,mainIdea:summary.mainIdea,summary,status:"completed",errorMessage:"",updatedAt:now()}});await jref.update({data:{status:"completed",updatedAt:now()}});return;}
  const segs=(await db.collection(C.segments).where({openid:job.openid,meetingId:job.meetingId}).orderBy("index","asc").get()).data;if(!segs.length)throw new Error("没有找到音频分段");const cursor=job.segmentCursor||0;
  if(cursor>=segs.length){const parts=job.transcriptParts||[];let offset=0,segments=[];for(let i=0;i<parts.length;i++){const dur=segs[i]?.duration||0;(parts[i].segments||[]).forEach(x=>segments.push({...x,start:(x.start||0)+offset,end:(x.end||0)+offset}));offset+=dur;}const transcript={text:parts.map(x=>x.text).join("\n"),segments};const existing=(await mref.get()).data;if(existing.transcript===null)await mref.update({data:{transcript:_.remove()}});await mref.update({data:{transcript,status:"summarizing",updatedAt:now()}});await jref.update({data:{stage:"summary",status:"queued",externalTaskId:null,updatedAt:now()}});return;}
  await jref.update({data:{status:"running",updatedAt:now()}});await mref.update({data:{status:"transcribing",updatedAt:now()}});let part;
  if(cfg.transcription.provider==="tencent"){part=await tencentStep(cfg.transcription,job,segs[cursor]);if(part.pending){await jref.update({data:{status:"queued",externalTaskId:part.externalTaskId||job.externalTaskId,updatedAt:now()}});return;}}
  else part=await openaiTranscribe(cfg.transcription,segs[cursor].fileId);
  const parts=[...(job.transcriptParts||[]),part];await jref.update({data:{status:"queued",segmentCursor:cursor+1,transcriptParts:parts,externalTaskId:null,updatedAt:now()}});
}
exports.main=async()=>{
  const r=await db.collection(C.jobs).where({status:"queued"}).orderBy("createdAt","asc").limit(5).get();
  if(!r.data.length)return {ok:true,idle:true};
  const results=[];
  for(const job of r.data){
    try{await processJob(job);results.push({jobId:job._id,ok:true});}
    catch(e){
      console.error("processor failure",{jobId:job._id,message:e.message});
      await db.collection(C.jobs).doc(job._id).update({data:{status:"failed",error:{message:e.message,stage:job.stage},updatedAt:now()}});
      await db.collection(C.meetings).doc(job.meetingId).update({data:{status:"failed",errorMessage:e.message,updatedAt:now()}});
      results.push({jobId:job._id,ok:false,error:e.message});
    }
  }
  return {ok:results.every(x=>x.ok),processed:results};
};
