App({
  globalData: { envId: "cloud1-d1gn26yde8fd1f267" },
  onLaunch() {
    if (!wx.cloud) throw new Error("请使用支持云开发的微信基础库");
    wx.cloud.init({ env: this.globalData.envId, traceUser: true });
  }
});
