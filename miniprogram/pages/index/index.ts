import { callApi, formatDate, formatDuration } from "../../utils/cloud";

const STATUS: Record<string,string> = { uploading:"上传中", queued:"等待处理", transcribing:"识别中", summarizing:"总结中", completed:"已完成", failed:"处理失败" };
Page({
  data: { loading: true, meetings: [] as any[], wave: [30,52,75,42,88,55,32,66,92,48,72,38,60,82,44,68] },
  onShow() { this.loadMeetings(); },
  async loadMeetings() {
    this.setData({ loading: true });
    try {
      const rows = await callApi<any[]>("listMeetings");
      this.setData({ meetings: rows.map(x => ({ ...x, title:x.title || "未命名会议", mainIdea:x.mainIdea || STATUS[x.status] || "等待处理", statusLabel:STATUS[x.status] || x.status, durationLabel:formatDuration(x.duration), createdLabel:formatDate(x.createdAt) })) });
    } catch (e:any) { wx.showToast({ title:e.message, icon:"none" }); }
    finally { this.setData({ loading:false }); }
  },
  async startRecording() {
    try {
      const status = await callApi<any>("getProviderConfigStatus");
      if (!status.transcription || !status.summary) {
        wx.showModal({ title:"先完成接口设置", content:"需要配置语音识别和总结接口。录音仍可保存，但无法自动生成纪要。", confirmText:"去设置", success:r => r.confirm && wx.navigateTo({url:"/pages/settings/settings"}) });
        return;
      }
      wx.navigateTo({ url:"/pages/record/record" });
    } catch (e:any) { wx.showToast({title:e.message,icon:"none"}); }
  },
  openSettings(){ wx.navigateTo({url:"/pages/settings/settings"}); },
  openDetail(e:any){ wx.navigateTo({url:`/pages/detail/detail?id=${e.currentTarget.dataset.id}`}); }
});
