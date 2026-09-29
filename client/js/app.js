// 应用入口：标签页、在线/离线状态、启动同步
const App = {
  async init() {
    await IDB.open();

    // 标签页切换
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        document.getElementById('tab-' + t.dataset.tab).classList.add('active');
        if (t.dataset.tab === 'anomalies') Anomalies.render();
        if (t.dataset.tab === 'dispatch') Dispatch.render();
      });
    });

    // 在线/离线
    const updateNet = () => {
      UI.setSyncState(navigator.onLine ? 'online' : 'offline');
      document.getElementById('offlineBanner').classList.toggle('hidden', navigator.onLine);
      if (navigator.onLine) Sync.syncNow().then(() => {
        Dispatch.render();
        Anomalies.render();
        UI.refreshAnomalyBadge();
      });
    };
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);

    document.getElementById('syncBtn').addEventListener('click', async () => {
      if (!navigator.onLine) { UI.toast('当前离线，记录已保存在本机，恢复联网后自动同步', true); return; }
      const r = await Sync.syncNow();
      if (r.error) UI.toast('同步失败：' + r.error, true);
      else if (r.sent === 0) UI.toast('没有待同步记录');
      else UI.toast(`已同步 ${r.sent} 条记录`);
      await Dispatch.render();
      await Anomalies.render();
      await UI.refreshAnomalyBadge();
    });

    document.getElementById('seedBtn').addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/seed', { method: 'POST' });
        if (!resp.ok) throw new Error('seed failed');
        UI.toast('演示数据已载入');
        await Dispatch.render();
        await UI.refreshAnomalyBadge();
      } catch (e) {
        UI.toast('载入失败：' + e.message, true);
      }
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
      await Dispatch.render();
      await UI.refreshAnomalyBadge();
      UI.toast('已刷新');
    });

    // 启动：载入缓存并尝试同步
    updateNet();
    await Vehicle.init();
    await Dispatch.render();
    await UI.refreshAnomalyBadge();

    // 注册 Service Worker（离线缓存外壳）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
