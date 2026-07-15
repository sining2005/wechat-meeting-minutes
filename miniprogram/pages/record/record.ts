import { callApi, formatDuration } from "../../utils/cloud";

const recorder = wx.getRecorderManager();

function voiceId() {
  return `meeting-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

Page({
  data: {
    meetingId:"", title:"", seconds:0, timeLabel:"00:00:00", paused:false,
    uploadText:"正在安全保存录音…", realtimeState:"正在连接实时转写…", realtimeText:"",
    wave:[32,56,84,42,68,105,55,76,120,62,94,48,72,112,58,88,38,70,100,52,78,116,46,82,62,108,40,92,55,72,104,60,86,44,98,54,74,110,48,80]
  },
  timer: 0 as any, segmentIndex: 0, autoRestart:false, uploadChain: Promise.resolve(), finishing:false,
  socket:null as WechatMiniprogram.SocketTask|null, socketReady:false, realtimeFailed:false,
  realtimeSegments:new Map<number, any>(), partialText:"", realtimeEndResolve:null as (()=>void)|null,
  stopResolve:null as (()=>void)|null,

  async onLoad() {
    const now = new Date();
    const title = `会议记录_${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    this.setData({title});
    try {
      const {meetingId} = await callApi<any>("createMeeting",{title});
      this.setData({meetingId});
      this.bindRecorder();
      this.startRealtime();
      this.startRecorder();
    } catch(e:any) { wx.showModal({title:"无法开始录音",content:e.message,showCancel:false,success:()=>wx.navigateBack()}); }
  },

  bindRecorder() {
    recorder.onFrameRecorded(frame => {
      if(this.socketReady && !this.data.paused && !this.finishing) {
        try { this.socket?.send({data:frame.frameBuffer}); } catch { this.realtimeFailed=true; }
      }
    });
    recorder.onStop(res => {
      const idx = this.segmentIndex++;
      this.uploadChain = this.uploadChain.then(() => this.uploadSegment(res.tempFilePath, idx, res.duration));
      const resolve=this.stopResolve; this.stopResolve=null; resolve?.();
      if(this.autoRestart && !this.finishing){ this.autoRestart=false; this.startRecorder(); }
    });
    recorder.onError(e => wx.showModal({title:"录音失败",content:e.errMsg,showCancel:false}));
  },

  startRecorder() {
    recorder.start({duration:590000,sampleRate:16000,numberOfChannels:1,encodeBitRate:48000,format:"mp3",frameSize:4});
    clearInterval(this.timer);
    this.timer=setInterval(()=>{ const seconds=this.data.seconds+1; this.setData({seconds,timeLabel:formatDuration(seconds)}); if(seconds>=3600)this.finish(); },1000);
    setTimeout(()=>{ if(!this.finishing){this.autoRestart=true;recorder.stop();} },588000);
  },

  async startRealtime() {
    if(this.socket || this.realtimeFailed || !this.data.meetingId)return;
    this.setData({realtimeState:"正在连接实时转写…"});
    try {
      const session=await callApi<any>("createRealtimeSession",{meetingId:this.data.meetingId,voiceId:voiceId()});
      const socket=wx.connectSocket({url:session.url}); this.socket=socket;
      socket.onOpen(()=>{ this.socketReady=true; this.setData({realtimeState:"实时转写中"}); });
      socket.onMessage(event=>this.consumeRealtimeMessage(event));
      socket.onError(()=>{ this.socketReady=false; this.socket=null; this.realtimeFailed=true; this.setData({realtimeState:"实时转写不可用，将在录音结束后补充识别"}); this.realtimeEndResolve?.(); this.realtimeEndResolve=null; });
      socket.onClose(()=>{ this.socketReady=false; this.socket=null; this.realtimeEndResolve?.(); this.realtimeEndResolve=null; });
    } catch(e:any) {
      this.realtimeFailed=true;
      this.setData({realtimeState:"实时转写不可用，将在录音结束后补充识别"});
    }
  },

  consumeRealtimeMessage(event:any) {
    let message:any;
    try { message=typeof event.data === "string" ? JSON.parse(event.data) : null; } catch { return; }
    if(!message)return;
    if(message.code && message.code !== 0) {
      this.realtimeFailed=true; this.setData({realtimeState:`实时转写错误：${message.message || message.code}`}); return;
    }
    if(message.final === 1) { this.setData({realtimeState:"实时转写完成"}); this.realtimeEndResolve?.(); this.realtimeEndResolve=null; return; }
    const speakerResults=message.sentences?(Array.isArray(message.sentences)?message.sentences:[message.sentences]):[];
    if(speakerResults.length) {
      speakerResults.forEach((sentence:any)=>{
        const index=Number(sentence.sentence_id);
        const text=String(sentence.sentence||sentence.text||"").trim();
        if(!Number.isInteger(index)||!text)return;
        const speakerId=Number(sentence.speaker_id);
        const speaker=Number.isInteger(speakerId)&&speakerId>=0?`说话人${speakerId+1}`:"说话人待确认";
        const segment={start:(Number(sentence.start_time)||0)/1000,end:(Number(sentence.end_time)||0)/1000,speakerId:Number.isInteger(speakerId)&&speakerId>=0?speakerId:null,speaker,text};
        if(Number(sentence.sentence_type)===1){this.realtimeSegments.set(index,segment);this.partialText="";}
        else this.partialText=`${speaker}：${text}`;
      });
    } else {
      const result=message.result;
      if(!result || typeof result.index !== "number")return;
      const text=String(result.voice_text_str||"").trim();
      if(result.slice_type === 2 && text) { this.realtimeSegments.set(result.index,{start:(Number(result.start_time)||0)/1000,end:(Number(result.end_time)||0)/1000,speakerId:null,speaker:"说话人",text}); this.partialText=""; }
      else if(result.slice_type === 1 && text) this.partialText=`说话人：${text}`;
    }
    const stable=[...this.realtimeSegments.entries()].sort((a,b)=>a[0]-b[0]).map(([,x])=>`${x.speaker||"说话人"}：${x.text}`).join("\n");
    this.setData({realtimeText:[stable,this.partialText].filter(Boolean).join("\n")});
  },

  async endRealtime() {
    if(!this.socketReady || !this.socket) return;
    const socket=this.socket;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{ try{socket.close({code:1000,reason:"recording ended"});}catch{} resolve(); },2500);
      this.realtimeEndResolve=()=>{clearTimeout(timer);resolve();};
      try { socket.send({data:JSON.stringify({type:"end"})}); } catch { clearTimeout(timer);resolve(); }
    });
  },

  transcript() {
    const segments=[...this.realtimeSegments.entries()].sort((a,b)=>a[0]-b[0]).map(([,x])=>x);
    const text=segments.map(x=>`${x.speaker||"说话人"}：${x.text}`).join("\n").trim();
    return text ? {text,segments} : null;
  },

  async uploadSegment(path:string,index:number,durationMs:number) {
    this.setData({uploadText:`正在上传第 ${index+1} 段…`});
    const cloudPath=`recordings/${this.data.meetingId}/${String(index).padStart(3,"0")}.mp3`;
    const result=await wx.cloud.uploadFile({cloudPath,filePath:path});
    await callApi("registerSegment",{meetingId:this.data.meetingId,index,fileId:result.fileID,duration:Math.round(durationMs/1000)});
    this.setData({uploadText:"录音已安全保存到云端"});
  },

  togglePause() {
    if(this.data.paused) {
      recorder.resume(); this.startRealtime();
      this.timer=setInterval(()=>{const seconds=this.data.seconds+1;this.setData({seconds,timeLabel:formatDuration(seconds)});},1000);
    } else {
      recorder.pause(); clearInterval(this.timer); this.realtimeFailed=true; this.endRealtime();
      this.setData({realtimeState:"暂停后将使用录后识别兜底"});
    }
    this.setData({paused:!this.data.paused});
  },

  addMarker(){ wx.showToast({title:"已添加时间标记",icon:"success"}); },

  async finish() {
    if(this.finishing)return;
    this.finishing=true; clearInterval(this.timer); this.autoRestart=false;
    const stopped=new Promise<void>(resolve=>{this.stopResolve=resolve;});
    recorder.stop();
    this.setData({uploadText:"正在完成上传，请勿退出…",realtimeState:"正在结束实时转写…"});
    await Promise.all([stopped,this.endRealtime()]);
    try {
      await this.uploadChain;
      const realtimeTranscript=this.realtimeFailed?null:this.transcript();
      await callApi("finishRecording",{meetingId:this.data.meetingId,duration:this.data.seconds,realtimeTranscript});
      wx.showToast({title:realtimeTranscript?"正在生成纪要":"正在补充识别",icon:"success"});
      setTimeout(()=>wx.redirectTo({url:`/pages/detail/detail?id=${this.data.meetingId}`}),500);
    } catch(e:any) { this.finishing=false; wx.showModal({title:"保存未完成",content:e.message,showCancel:false}); }
  },

  cancel(){ wx.showModal({title:"结束录音？",content:"当前录音会先安全保存。",success:r=>r.confirm&&this.finish()}); },
  onUnload(){ clearInterval(this.timer); if(!this.finishing){this.finishing=true;recorder.stop();} try{this.socket?.close({code:1000,reason:"page closed"});}catch{} }
});
