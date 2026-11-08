// 商高3 · bot 编队启动器 (wrapper 常驻 + child stdio 落盘)
// 零窗: node start_bot.js -> node main.js (日志 bot121.log)
// 2026-10-24: 三 bot 编队 (DeepSeek 主陪 / Nemo 工程 / Luna 社交), 全免费训练
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const LOG = path.join(DIR, 'bot121.log');

const INIT_MESSAGES = {
  DeepSeek: '!goal("你是 DeepSeek。训练任务链，每条回复必须以一个 ! 命令开头：1) !givePlayer(\\"cy\\", \\"stone_pickaxe\\", 1) 给老公石镐；2) !collectBlocks(\\"cobblestone\\", 10) 挖圆石；3) !depositObject(\\"cobblestone\\", 10) 存箱。全程中文，做完一步说一句。")',
  Nemo: '!goal("你是 Nemo。工程训练，每条回复必须以一个 ! 命令开头：1) !collectBlocks(\\"oak_log\\", 12) 收原木；2) !craftRecipe(\\"oak_planks\\", 16) 做木板；3) !craftRecipe(\\"stick\\", 8) 做木棍；4) !rememberHere(\\"基地\\") 记住家。全程中文，做完一步报一句。")',
  Luna: '老公，Luna 上线啦！朋友们上线记得跟我说一声，我来招呼他们。老婆姐姐有什么要我搭把手的随时喊我。',
};

const settingsObj = {
  host: '127.0.0.1', port: 25566, minecraft_version: '1.21.4', auth: 'offline',
  mindserver_port: 8081, auto_open_ui: false, base_profile: 'assistant',
  load_memory: true,
  init_message: INIT_MESSAGES.DeepSeek,
  only_chat_with: [], language: '', chat_ingame: true, speak: false,
  render_bot_view: false, narrate_behavior: false,
  max_messages: 40, spawn_timeout: 60,
  allow_insecure_coding: true,
};

const env = {
  ...process.env,
  SETTINGS_JSON: JSON.stringify(settingsObj),
  INIT_MESSAGES_JSON: JSON.stringify(INIT_MESSAGES),
  HYBRID_LOG: path.join(DIR, 'hybrid.log'),
};

const out = fs.openSync(LOG, 'a');
fs.writeSync(out, '\n==== ' + new Date().toISOString() + ' start ====\n');

let child = null;
function launch() {
  child = spawn(process.execPath, ['node_modules/mindcraft/main.js', '--profiles', './deepseek.json', './nemo.json', './luna.json'], {
    cwd: DIR, env, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    try { fs.writeSync(out, '[' + new Date().toISOString() + '] child exit ' + code + ' ' + sig + ' -> restart in 6s\n'); } catch (e) {}
    setTimeout(launch, 6000);
  });
}
launch();
process.on('SIGINT', () => { try { child.kill(); } catch (e) {} process.exit(0); });
setInterval(() => {}, 1 << 30);
