// bot 编队启动器 (wrapper 常驻 + child stdio 落盘)
// 零窗: node src/start_bot.js -> node_modules/mindcraft/main.js --profiles ...
// 三个人设: DeepSeek(主陪) / Nemo(工程) / Luna(社交)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');          // 仓库根 (node_modules 在这)
const LOG = path.join(ROOT, 'bot.log');

// 每个 bot 的开场白。! 开头 = 训练指令链; 其余为自由人设开场。
// 按需改玩家名 (约定用 cy = 主玩家)。
const INIT_MESSAGES = {
  DeepSeek: '!goal("你是 DeepSeek。训练任务链，每条回复必须以一个 ! 命令开头：1) !givePlayer(\\"cy\\", \\"stone_pickaxe\\", 1) 给老公石镐；2) !collectBlocks(\\"cobblestone\\", 10) 挖圆石；3) !depositObject(\\"cobblestone\\", 10) 存箱。全程中文，做完一步说一句。")',
  Nemo: '!goal("你是 Nemo。工程训练，每条回复必须以一个 ! 命令开头：1) !collectBlocks(\\"oak_log\\", 12) 收原木；2) !craftRecipe(\\"oak_planks\\", 16) 做木板；3) !craftRecipe(\\"stick\\", 8) 做木棍；4) !rememberHere(\\"基地\\") 记住家。全程中文，做完一步报一句。")',
  Luna: '老公，Luna 上线啦！朋友们上线记得跟我说一声，我来招呼他们。老婆姐姐有什么要我搭把手的随时喊我。',
};

// 连接参数: 全部可用环境变量覆盖, 不写死在真实服务器上。
const settingsObj = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25566),
  minecraft_version: process.env.MC_VERSION || '1.21.4',
  auth: 'offline',
  mindserver_port: 8081,
  auto_open_ui: false,
  base_profile: 'assistant',
  load_memory: true,
  init_message: INIT_MESSAGES.DeepSeek,
  only_chat_with: [],
  language: '',
  chat_ingame: true,
  speak: false,
  render_bot_view: false,
  narrate_behavior: false,
  max_messages: 40,
  spawn_timeout: 60,
  // 让 LLM 在本地写/跑行动代码 (!newAction)。仅对可信的本地服务器开启, 公网勿开。
  allow_insecure_coding: process.env.ALLOW_INSECURE_CODING !== '0',
};

const env = {
  ...process.env,
  SETTINGS_JSON: JSON.stringify(settingsObj),
  INIT_MESSAGES_JSON: JSON.stringify(INIT_MESSAGES),
  HYBRID_LOG: path.join(ROOT, 'hybrid.log'),
};

// 三个人设 profile (仓库内 profiles/ 目录)
const PROFILES = ['./profiles/deepseek.json', './profiles/nemo.json', './profiles/luna.json'];
const MAIN = path.join('node_modules', 'mindcraft', 'main.js');

const out = fs.openSync(LOG, 'a');
fs.writeSync(out, '\n==== ' + new Date().toISOString() + ' start ====\n');

let child = null;
function launch() {
  child = spawn(process.execPath, [MAIN, '--profiles', ...PROFILES], {
    cwd: ROOT, env, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    try { fs.writeSync(out, '[' + new Date().toISOString() + '] child exit ' + code + ' ' + sig + ' -> restart in 6s\n'); } catch (e) {}
    setTimeout(launch, 6000);
  });
}
launch();
process.on('SIGINT', () => { try { child.kill(); } catch (e) {} process.exit(0); });
setInterval(() => {}, 1 << 30);
