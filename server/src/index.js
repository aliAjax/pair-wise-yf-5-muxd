// 服务入口：HTTP API + 静态页面
const path = require('path');
const express = require('express');
const { initDb } = require('./db');
const { createApi, seed } = require('./api');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'coldchain.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = initDb(DB_FILE);
if (process.env.SEED) seed(db);

const app = express();
app.use('/api', createApi(db));
app.use(express.static(path.join(__dirname, '..', '..', 'client')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`冷链离线交接台服务已启动: http://localhost:${PORT}`);
});
