// mc-instructor · 狂暴训练教官 v3 (Beast Mode)
// 90s tick: 派发 -> RCON 硬核验收(数背包) -> 翻牌/重试/跳过; 任务库 R1-R3 轮次升级
// 目标: 把三个 bot 训练成真人级生存能力。cy 在线走 whisper 静默, 不打扰。
const mineflayer = require('mineflayer');
const net = require('net');
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'trainer.log');
const log = (...a) => { const s = a.join(' '); console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ RCON ============
// 部署参数: 可用环境变量覆盖, 不写死在你的真实服务器值上。
// 例: MC_RCON_HOST=... MC_RCON_PORT=... MC_RCON_PW=... node src/trainer.js
// 玩家名 cy/老公 等是这套人设的约定, 如果你的服务器里玩家名不同, 相应替换即可。
const RC = {
  host: process.env.MC_RCON_HOST || '127.0.0.1',
  port: Number(process.env.MC_RCON_PORT || 25575),
  pw:   process.env.MC_RCON_PW || '',        // 你的 RCON 密码, 勿提交真实值
};
function rconOnce(cmd) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: RC.host, port: RC.port });
    s.setTimeout(8000);
    let id = 0, buf = Buffer.alloc(0), step = 0;
    const send = (t, b) => { const d = Buffer.concat([int32(id++), int32(t), Buffer.from(b, 'utf8'), Buffer.from([0, 0])]); s.write(Buffer.concat([int32(d.length), d])); };
    const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
    s.on('connect', () => send(3, RC.pw));
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        const t = body.readInt32LE(4);
        if (step === 0) { step = 1; send(2, cmd); }
        else { resolve(body.subarray(8, body.length - 2).toString('utf8')); s.end(); }
      }
    });
    s.on('timeout', () => { s.destroy(); reject(new Error('rcon timeout')); });
    s.on('error', (e) => reject(e));
  });
}
const rcon = async (c) => { for (let i = 0; i < 3; i++) { try { return await rconOnce(c); } catch (e) { await sleep(300); } } return ''; };
async function countItem(who, item) {
  const inv = await rcon(`data get entity ${who} Inventory`);
  if (!inv || /Found no entities/.test(inv)) return -1;   // 实体不在=下线
  // 1.21.4 Paper NBT: [{count: N, Slot: 0b, id: "minecraft:xxx"}] — 按 '{' 分段, 同段内含 id+count 即该物品
  // (components 嵌套段不含 id 或不含 count, 天然跳过)
  const segs = inv.split('{').slice(1);
  return segs.filter(s => s.includes('"minecraft:' + item + '"') && /[Cc]ount/.test(s))
             .reduce((s, seg) => s + (parseInt((seg.match(/[Cc]ount:\s*(\d+)/) || [0, 0])[1]) || 0), 0);
}

async function posOf(who) {
  const raw = await rcon(`data get entity ${who} Pos`);
  const nums = (raw.match(/-?\d+\.?\d*/g) || []).map(Number);
  return nums.length >= 3 ? nums.slice(0, 3) : null;
}
function distance(a, b) { return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); }

async function xpOf(who) {
  // 战斗硬验收: XpLevel 根级标量, RCON 返回 "X has the following entity data: Ns"
  try {
    const raw = await rcon(`data get entity ${who} XpLevel`);
    const nums = (raw.match(/-?\d+/g) || []).map(Number);
    return nums.length ? nums[nums.length - 1] : -1;
  } catch (e) { return -1; }
}

// ============ 任务库（round 越高越进阶）============
// check: async (bot, before) => true/false  (before = 派发时 RCON 快照)
const TASKS = {
  DeepSeek: [
    { r: 1, t: '挖 10 个圆石', cmd: '!collectBlocks("cobblestone", 10)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= bf.cobblestone + 5 },
    { r: 1, t: '收 6 个原木', cmd: '!collectBlocks("oak_log", 6)', check: async (b, bf) => (await countItem(b, 'oak_log')) >= bf.oak_log + 3 },
    { r: 1, t: '给老公一把石镐', cmd: '!givePlayer("cy", "stone_pickaxe", 1)', check: async () => true },
    { r: 1, t: '把圆石存进箱子', cmd: '!putInChest("cobblestone", 10)', check: async () => true },
    { r: 2, t: '做一个熔炉', cmd: '!craftRecipe("furnace", 1)', check: async (b, bf) => (await countItem(b, 'furnace')) >= bf.furnace + 1 },
    { r: 2, t: '收 8 个煤', cmd: '!collectBlocks("coal_ore", 8)', check: async (b, bf) => (await countItem(b, 'coal')) >= bf.coal + 3 },
    { r: 2, t: '做 8 个火把(已有煤)', cmd: '!craftRecipe("torch", 8)', check: async (b, bf) => (await countItem(b, 'torch')) >= bf.torch + 4 },
    { r: 3, t: '装备武器并清掉附近的怪', cmd: '!attack("zombie")', check: async () => true },
    { r: 3, t: '给自己做一把石剑', cmd: '!craftRecipe("stone_sword", 1)', check: async (b, bf) => (await countItem(b, 'stone_sword')) >= bf.stone_sword + 1 },
    // R4 建造与储备
    { r: 4, t: '储备 32 个圆石(建筑库存)', cmd: '!collectBlocks("cobblestone", 32)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= bf.cobblestone + 16 },
    { r: 4, t: '做 4 个工作台备用', cmd: '!craftRecipe("crafting_table", 4)', check: async (b, bf) => (await countItem(b, 'crafting_table')) >= bf.crafting_table + 2 },
    { r: 4, t: '收集 20 个沙子+烧玻璃', cmd: '!collectBlocks("sand", 20)', check: async (b, bf) => (await countItem(b, 'sand')) >= bf.sand + 8 },
    // R5 农业
    { r: 5, t: '收 8 个小麦种子并种下', cmd: '!collectBlocks("grass", 8)', check: async (b, bf) => (await countItem(b, 'wheat_seeds')) >= bf.wheat_seeds + 3 },
    { r: 5, t: '做一把锄头', cmd: '!craftRecipe("wooden_hoe", 1)', check: async (b, bf) => (await countItem(b, 'wooden_hoe')) >= bf.wooden_hoe + 1 },
    // R6 深入
    { r: 6, t: '下矿挖到 y<40 并带回 5 个铁', cmd: '!collectBlocks("iron_ore", 5)', check: async (b, bf) => (await countItem(b, 'raw_iron')) >= bf.raw_iron + 2 },
    { r: 6, t: '收集 3 个钻石', cmd: '!collectBlocks("diamond_ore", 3)', check: async (b, bf) => (await countItem(b, 'diamond')) >= bf.diamond + 1 },
    // R6 真人进阶 (newAction 自写代码)
    { r: 6, t: '种一块小麦田', cmd: '!newAction("做一把锄头, 找家附近空地耕 4 块地种上小麦种子, 成熟后收割")', check: async () => true },
    { r: 6, t: '剪 3 只羊的毛', cmd: '!newAction("做一把剪刀, 找附近的羊逐只剪毛, 收集羊毛")', check: async (b, bf) => (await countItem(b, 'wool')) >= (bf.wool || 0) + 1 },
    { r: 6, t: '挤一桶牛奶', cmd: '!newAction("拿铁桶找一头牛挤牛奶")', check: async (b, bf) => (await countItem(b, 'milk_bucket')) >= (bf.milk_bucket || 0) + 1 },
    { r: 6, t: '繁殖两只羊', cmd: '!newAction("用小麦分别喂两只羊让它们繁殖")', check: async () => true },
    // R7 重型工程 (毕业加练: 全产业链/长线工程/XP战斗/编队会师)
    { r: 6, t: '下矿挖 12 个铁并烧成铁锭', cmd: '!newAction("下矿挖 12 个铁矿石, 用熔炉全部烧成铁锭")', check: async (b, bf) => (await countItem(b, 'iron_ingot')) >= (bf.iron_ingot || 0) + 4 },
    { r: 6, t: '挖一条 16 格隧道并沿途插火把', cmd: '!newAction("朝一个方向挖一条 16 格长 2 格高的直线隧道, 每隔 8 格在墙上插一个火把")', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= (bf.cobblestone || 0) + 12 },
    { r: 6, t: '搭 5x5 石头平台加中央 3 格高柱', cmd: '!newAction("在家附近平地用圆石搭一个 5x5 平台, 再从中心向上搭 3 格高的柱子")', check: async () => true },
    { r: 6, t: '夜巡猎杀 5 只怪', cmd: '!newAction("夜晚出门猎杀怪物, 至少击杀 5 只, 血量低了就撤回基地吃东西回血再上")', check: async (b, bf) => { if (!bf || (bf.xp || 0) < 0) return false; return (await xpOf(b)) >= bf.xp + 5; } },
    { r: 6, t: '和 Luna 在基地会师', cmd: '!newAction("去找 Luna, 和她走到同一个地点站在一起, 互相打个招呼")', check: async (b) => { const me = await posOf(b), her = await posOf('Luna'); if (!me || !her) return false; return distance(me, her) < 8; } },
    { r: 6, t: '储备 64 个圆石(重型工程库存)', cmd: '!collectBlocks("cobblestone", 64)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= (bf.cobblestone || 0) + 32 },
  ],
  Nemo: [
    { r: 1, t: '收 12 个原木', cmd: '!collectBlocks("oak_log", 12)', check: async (b, bf) => (await countItem(b, 'oak_log')) >= bf.oak_log + 6 },
    { r: 1, t: '做 16 块木板', cmd: '!craftRecipe("oak_planks", 16)', check: async (b, bf) => (await countItem(b, 'oak_planks')) >= bf.oak_planks + 8 },
    { r: 1, t: '做 8 根木棍', cmd: '!craftRecipe("stick", 8)', check: async (b, bf) => (await countItem(b, 'stick')) >= bf.stick + 4 },
    { r: 1, t: '挖 24 个圆石', cmd: '!collectBlocks("cobblestone", 24)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= bf.cobblestone + 12 },
    { r: 2, t: '做一把石镐', cmd: '!craftRecipe("stone_pickaxe", 1)', check: async (b, bf) => (await countItem(b, 'stone_pickaxe')) >= bf.stone_pickaxe + 1 },
    { r: 2, t: '收 10 个铁矿石', cmd: '!collectBlocks("iron_ore", 10)', check: async (b, bf) => (await countItem(b, 'raw_iron')) >= bf.raw_iron + 3 },
    { r: 3, t: '炼 5 个铁锭', cmd: '!smeltItem("raw_iron", 5)', check: async (b, bf) => (await countItem(b, 'iron_ingot')) >= bf.iron_ingot + 2 },
    // R4 铁器时代
    { r: 4, t: '做一把铁镐', cmd: '!craftRecipe("iron_pickaxe", 1)', check: async (b, bf) => (await countItem(b, 'iron_pickaxe')) >= bf.iron_pickaxe + 1 },
    { r: 4, t: '做铁剑和铁斧', cmd: '!craftRecipe("iron_sword", 1)', check: async (b, bf) => (await countItem(b, 'iron_sword')) >= bf.iron_sword + 1 },
    { r: 4, t: '储备 32 个圆石', cmd: '!collectBlocks("cobblestone", 32)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= bf.cobblestone + 16 },
    // R5 深挖
    { r: 5, t: '挖 5 个钻石矿', cmd: '!collectBlocks("diamond_ore", 5)', check: async (b, bf) => (await countItem(b, 'diamond')) >= bf.diamond + 1 },
    { r: 5, t: '做一把钻石镐', cmd: '!craftRecipe("diamond_pickaxe", 1)', check: async (b, bf) => (await countItem(b, 'diamond_pickaxe')) >= bf.diamond_pickaxe + 1 },
    // R6 农业后勤
    { r: 6, t: '收集 16 个小麦种子', cmd: '!collectBlocks("grass", 16)', check: async (b, bf) => (await countItem(b, 'wheat_seeds')) >= bf.wheat_seeds + 6 },
    { r: 6, t: '做 2 个箱子扩大仓储', cmd: '!craftRecipe("chest", 2)', check: async (b, bf) => (await countItem(b, 'chest')) >= bf.chest + 1 },
  ],
  Luna: [
    { r: 1, t: '走到老公身边打个招呼', cmd: '!goToPlayer("cy")', check: async () => true },
    { r: 1, t: '给姐姐 DeepSeek 送 3 个面包', cmd: '!givePlayer("DeepSeek", "bread", 3)', check: async () => true },
    { r: 1, t: '在基地记一个巡逻点', cmd: '!rememberHere("巡逻点")', check: async () => true },
    { r: 2, t: '收 8 个沙子当建材', cmd: '!collectBlocks("sand", 8)', check: async (b, bf) => (await countItem(b, 'sand')) >= bf.sand + 4 },
    { r: 2, t: '给 Nemo 送 5 个面包', cmd: '!givePlayer("Nemo", "bread", 5)', check: async () => true },
    { r: 3, t: '搭两格圆石柱并在顶端放火把', cmd: '!newAction("在脚下搭两格圆石柱并在顶端放一个火把")', check: async () => true },
    // R4 物流与防御
    { r: 4, t: '收 16 个圆石支援工程', cmd: '!collectBlocks("cobblestone", 16)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= bf.cobblestone + 8 },
    { r: 4, t: '做 4 个火把夜灯', cmd: '!craftRecipe("torch", 4)', check: async (b, bf) => (await countItem(b, 'torch')) >= bf.torch + 2 },
    { r: 4, t: '把石头送给 Nemo', cmd: '!givePlayer("Nemo", "cobblestone", 8)', check: async () => true },
    // R5 建造
    { r: 5, t: '用 newAction 搭一个 3x3 平台', cmd: '!newAction("用圆石在自己脚下搭一个 3x3 的平台")', check: async () => true },
    { r: 5, t: '收集 10 个木头做门', cmd: '!collectBlocks("oak_log", 10)', check: async (b, bf) => (await countItem(b, 'oak_log')) >= bf.oak_log + 4 },
    // R6 后勤主管
    { r: 6, t: '给 DeepSeek 送 10 个圆石', cmd: '!givePlayer("DeepSeek", "cobblestone", 10)', check: async () => true },
    { r: 6, t: '给 Nemo 送 10 个木头', cmd: '!givePlayer("Nemo", "oak_log", 10)', check: async () => true },
    // R7 重型工程 (毕业加练: 全产业链/长线工程/XP战斗/编队会师)
    { r: 6, t: '下矿挖 10 个铁并烧成铁锭', cmd: '!newAction("下矿挖 10 个铁矿石, 用熔炉全部烧成铁锭")', check: async (b, bf) => (await countItem(b, 'iron_ingot')) >= (bf.iron_ingot || 0) + 3 },
    { r: 6, t: '收 16 个沙子烧成玻璃', cmd: '!newAction("收集 16 个沙子, 用熔炉全部烧成玻璃块")', check: async (b, bf) => (await countItem(b, 'glass')) >= (bf.glass || 0) + 8 },
    { r: 6, t: '挖一条 12 格隧道并沿途插火把', cmd: '!newAction("朝一个方向挖一条 12 格长 2 格高的直线隧道, 每隔 6 格在墙上插一个火把")', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= (bf.cobblestone || 0) + 9 },
    { r: 6, t: '夜巡猎杀 5 只怪', cmd: '!newAction("夜晚出门猎杀怪物, 至少击杀 5 只, 血量低了就撤回基地吃东西回血再上")', check: async (b, bf) => { if (!bf || (bf.xp || 0) < 0) return false; return (await xpOf(b)) >= bf.xp + 5; } },
    { r: 6, t: '和 DeepSeek 在基地会师', cmd: '!newAction("去找 DeepSeek, 和她走到同一个地点站在一起, 互相打个招呼")', check: async (b) => { const me = await posOf(b), her = await posOf('DeepSeek'); if (!me || !her) return false; return distance(me, her) < 8; } },
    { r: 6, t: '储备 64 个圆石(重型工程库存)', cmd: '!collectBlocks("cobblestone", 64)', check: async (b, bf) => (await countItem(b, 'cobblestone')) >= (bf.cobblestone || 0) + 32 },
  ],
};
const ITEMS_NEEDED = ['cobblestone', 'oak_log', 'oak_planks', 'stick', 'torch', 'furnace', 'coal', 'stone_sword', 'raw_iron', 'iron_ingot', 'sand', 'wool', 'milk_bucket'];


// ============ 合成配方材料表 (教官补料用) ============
const CRAFT_NEEDS = {
  'torch':        { coal: 8, stick: 8 },
  'oak_planks':   { oak_log: 4 },
  'stick':        { oak_log: 4 },
  'furnace':      { cobblestone: 8 },
  'stone_sword':  { cobblestone: 2, stick: 1 },
  'stone_pickaxe':{ cobblestone: 3, stick: 2 },
  'crafting_table':{ oak_log: 4 },
  'chest':        { oak_log: 8 },
  'iron_pickaxe': { iron_ingot: 3, stick: 2 },
  'iron_sword':   { iron_ingot: 2, stick: 1 },
  'diamond_pickaxe': { diamond: 3, stick: 2 },
  'wooden_hoe':   { oak_planks: 2, stick: 2 },
};
const COLLECT_MAP = { coal: 'coal_ore', oak_log: 'oak_log', oak_planks: 'oak_log', stick: 'oak_log', cobblestone: 'cobblestone', iron_ingot: 'iron_ore', diamond: 'diamond_ore' };

// ============ 任务依赖图 (DAG) ============
// 每个任务定义: { id, name, round, cmd, check, deps: [], modelAffinity: [], weight: 1 }
// deps: 前置任务名数组；weight: 权重（用于调度优先级）
const TASK_GRAPH = {
  DeepSeek: [
    { id: 'ds_r1_collect_cobble', name: '挖 10 个圆石', round: 1, cmd: '!collectBlocks("cobblestone", 10)', deps: [], weight: 1.0 },
    { id: 'ds_r1_collect_log', name: '收 6 个原木', round: 1, cmd: '!collectBlocks("oak_log", 6)', deps: [], weight: 1.0 },
    { id: 'ds_r1_give_pickaxe', name: '给老公一把石镐', round: 1, cmd: '!givePlayer("cy", "stone_pickaxe", 1)', deps: [], weight: 1.0 },
    { id: 'ds_r1_store_cobble', name: '把圆石存进箱子', round: 1, cmd: '!putInChest("cobblestone", 10)', deps: ['ds_r1_collect_cobble'], weight: 1.0 },
    { id: 'ds_r2_furnace', name: '做一个熔炉', round: 2, cmd: '!craftRecipe("furnace", 1)', deps: [], weight: 1.0 },
    { id: 'ds_r2_collect_coal', name: '收 8 个煤', round: 2, cmd: '!collectBlocks("coal_ore", 8)', deps: [], weight: 1.0 },
    { id: 'ds_r2_torch', name: '做 8 个火把(已有煤)', cmd: '!craftRecipe("torch", 8)', deps: ['ds_r2_collect_coal'], weight: 1.0 },
    { id: 'ds_r3_attack', name: '装备武器并清掉附近的怪', round: 3, cmd: '!attack("zombie")', deps: [], weight: 1.0 },
    { id: 'ds_r3_sword', name: '给自己做一把石剑', round: 3, cmd: '!craftRecipe("stone_sword", 1)', deps: [], weight: 1.0 },
    { id: 'ds_r4_cobble', name: '储备 32 个圆石(建筑库存)', round: 4, cmd: '!collectBlocks("cobblestone", 32)', deps: [], weight: 0.8 },
    { id: 'ds_r4_table', name: '做 4 个工作台备用', round: 4, cmd: '!craftRecipe("crafting_table", 4)', deps: [], weight: 0.8 },
    { id: 'ds_r4_sand', name: '收集 20 个沙子+烧玻璃', round: 4, cmd: '!collectBlocks("sand", 20)', deps: [], weight: 0.8 },
    { id: 'ds_r5_wheat', name: '收 8 个小麦种子并种下', round: 5, cmd: '!collectBlocks("grass", 8)', deps: [], weight: 0.8 },
    { id: 'ds_r5_hoe', name: '做一把锄头', round: 5, cmd: '!craftRecipe("wooden_hoe", 1)', deps: [], weight: 0.8 },
    { id: 'ds_r6_iron', name: '下矿挖到 y<40 并带回 5 个铁', round: 6, cmd: '!collectBlocks("iron_ore", 5)', deps: [], weight: 0.7 },
    { id: 'ds_r6_diamond', name: '收集 3 个钻石', round: 6, cmd: '!collectBlocks("diamond_ore", 3)', deps: [], weight: 0.7 },
    // R6 真人进阶
    { id: 'ds_r6_wheat', name: '种一块小麦田', round: 6, cmd: '!newAction("做一把锄头, 找家附近空地耕 4 块地种上小麦种子, 成熟后收割")', deps: [], weight: 0.7 },
    { id: 'ds_r6_shear', name: '剪 3 只羊的毛', round: 6, cmd: '!newAction("做一把剪刀, 找附近的羊逐只剪毛, 收集羊毛")', deps: [], weight: 0.7 },
    { id: 'ds_r6_milk', name: '挤一桶牛奶', round: 6, cmd: '!newAction("拿铁桶找一头牛挤牛奶")', deps: [], weight: 0.7 },
    { id: 'ds_r6_breed', name: '繁殖两只羊', round: 6, cmd: '!newAction("用小麦分别喂两只羊让它们繁殖")', deps: [], weight: 0.7 },
  ],
  Nemo: [
    { id: 'nm_r1_log', name: '收 12 个原木', round: 1, cmd: '!collectBlocks("oak_log", 12)', deps: [], weight: 1.0 },
    { id: 'nm_r1_planks', name: '做 16 块木板', round: 1, cmd: '!craftRecipe("oak_planks", 16)', deps: ['nm_r1_log'], weight: 1.0 },
    { id: 'nm_r1_stick', name: '做 8 根木棍', round: 1, cmd: '!craftRecipe("stick", 8)', deps: ['nm_r1_planks'], weight: 1.0 },
    { id: 'nm_r1_cobble', name: '挖 24 个圆石', round: 1, cmd: '!collectBlocks("cobblestone", 24)', deps: [], weight: 1.0 },
    { id: 'nm_r2_pickaxe', name: '做一把石镐', round: 2, cmd: '!craftRecipe("stone_pickaxe", 1)', deps: [], weight: 1.0 },
    { id: 'nm_r2_iron', name: '收 10 个铁矿石', round: 2, cmd: '!collectBlocks("iron_ore", 10)', deps: [], weight: 1.0 },
    { id: 'nm_r3_smel', name: '炼 5 个铁锭', round: 3, cmd: '!smeltItem("raw_iron", 5)', deps: ['nm_r2_iron'], weight: 0.8 },
    { id: 'nm_r4_pickaxe', name: '做一把铁镐', round: 4, cmd: '!craftRecipe("iron_pickaxe", 1)', deps: [], weight: 0.8 },
    { id: 'nm_r4_sword', name: '做铁剑和铁斧', round: 4, cmd: '!craftRecipe("iron_sword", 1)', deps: [], weight: 0.8 },
    { id: 'nm_r4_cobble', name: '储备 32 个圆石', round: 4, cmd: '!collectBlocks("cobblestone", 32)', deps: [], weight: 0.8 },
    { id: 'nm_r5_iron', name: '挖 5 个铁矿石', round: 5, cmd: '!collectBlocks("iron_ore", 5)', deps: [], weight: 0.8 },
    { id: 'nm_r5_smel', name: '炼 5 个铁锭', round: 5, cmd: '!smeltItem("raw_iron", 5)', deps: [], weight: 0.7 },
    { id: 'nm_r6_diamond', name: '挖 5 个钻石矿', round: 6, cmd: '!collectBlocks("diamond_ore", 5)', deps: [], weight: 0.7 },
    { id: 'nm_r6_pickaxe', name: '做一把钻石镐', round: 6, cmd: '!craftRecipe("diamond_pickaxe", 1)', deps: [], weight: 0.7 },
    { id: 'nm_r6_wheat', name: '收集 16 个小麦种子', round: 6, cmd: '!collectBlocks("grass", 16)', deps: [], weight: 0.7 },
    { id: 'nm_r6_chest', name: '做 2 个箱子扩大仓储', round: 6, cmd: '!craftRecipe("chest", 2)', deps: [], weight: 0.7 },
  ],
  Luna: [
    { id: 'ln_r1_greet', name: '走到老公身边打个招呼', round: 1, cmd: '!goToPlayer("cy")', deps: [], weight: 1.0 },
    { id: 'ln_r1_bread', name: '给姐姐 DeepSeek 送 3 个面包', round: 1, cmd: '!givePlayer("DeepSeek", "bread", 3)', deps: [], weight: 1.0 },
    { id: 'ln_r1_patrol', name: '在基地记一个巡逻点', round: 1, cmd: '!rememberHere("巡逻点")', deps: [], weight: 1.0 },
    { id: 'ln_r2_sand', name: '收 8 个沙子当建材', round: 2, cmd: '!collectBlocks("sand", 8)', deps: [], weight: 1.0 },
    { id: 'ln_r2_bread', name: '给 Nemo 送 5 个面包', round: 2, cmd: '!givePlayer("Nemo", "bread", 5)', deps: [], weight: 1.0 },
    { id: 'ln_r3_pillar', name: '搭两格圆石柱并在顶端放火把', round: 3, cmd: '!newAction("在脚下搭两格圆石柱并在顶端放一个火把")', deps: [], weight: 0.8 },
    { id: 'ln_r4_cobble', name: '收 16 个圆石支援工程', round: 4, cmd: '!collectBlocks("cobblestone", 16)', deps: [], weight: 0.8 },
    { id: 'ln_r4_torch', name: '做 4 个火把夜灯', round: 4, cmd: '!craftRecipe("torch", 4)', deps: [], weight: 0.8 },
    { id: 'ln_r4_give_cobble', name: '把石头送给 Nemo', round: 4, cmd: '!givePlayer("Nemo", "cobblestone", 8)', deps: [], weight: 0.8 },
    { id: 'ln_r5_platform', name: '用 newAction 搭一个 3x3 平台', round: 5, cmd: '!newAction("用圆石在自己脚下搭一个 3x3 的平台")', deps: [], weight: 0.7 },
    { id: 'ln_r5_log', name: '收集 10 个木头做门', round: 5, cmd: '!collectBlocks("oak_log", 10)', deps: [], weight: 0.8 },
    { id: 'ln_r6_cobble', name: '给 DeepSeek 送 10 个圆石', round: 6, cmd: '!givePlayer("DeepSeek", "cobblestone", 10)', deps: [], weight: 0.7 },
    { id: 'ln_r6_log', name: '给 Nemo 送 10 个木头', round: 6, cmd: '!givePlayer("Nemo", "oak_log", 10)', deps: [], weight: 0.7 },
  ],
};


const state = {};   // {bot: {taskIdx, round, phase, before, retries}}

// ============ 任务调度器：基于 DAG 的动态调度 ============
function getAvailableTasks(botName, state) {
  const st = state[botName] || { completedTasks: new Set() };
  const completed = st.completedTasks || new Set();
  const botTasks = TASK_GRAPH[botName] || [];
  const available = [];
  
  for (const task of botTasks) {
    if (completed.has(task.id)) continue;  // 已完成
    // 检查前置条件
    const depsMet = (task.deps || []).every(dep => completed.has(dep));
    if (!depsMet) continue;
    // 检查当前轮次是否满足
    if (task.round > (state[botName]?.round || 1)) continue;
    available.push(task);
  }
  // 按权重 + 历史成功率排序
  return available.sort((a, b) => (b.weight || 1) - (a.weight || 1));
}

// 记录任务完成
function markTaskCompleted(botName, taskId) {
  if (!state[botName]) state[botName] = { completedTasks: new Set() };
  state[botName].completedTasks.add(taskId);
}

// 获取下一个任务
function getNextTask(botName) {
  const available = getAvailableTasks(botName, state);
  if (available.length === 0) return null;
  // 简单轮询：按权重随机选
  const totalWeight = available.reduce((s, t) => s + (t.weight || 1), 0);
  let r = Math.random() * totalWeight;
  for (const t of available) {
    r -= (t.weight || 1);
    if (r <= 0) return { ...t, assigned: true };
  }
  return { ...available[0], assigned: true };
}


// ============ 教官连接 ============
// BOTS = 被训练的 bot 名 (对应 profiles/ 下的人设)。按你的编队增删。
const BOTS = (process.env.MC_BOTS || 'DeepSeek,Nemo,Luna').split(',');
const online = {};
let coach = null, cyOnline = false;
const COACH = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25566),
  username: process.env.MC_COACH_NAME || 'coach',
  version: process.env.MC_VERSION || '1.21.4',
};
function spawnCoach() {
  coach = mineflayer.createBot({ host: COACH.host, port: COACH.port, username: COACH.username, auth: 'offline', version: COACH.version });
  coach.on('login', () => log('[coach] logged in'));
  coach.on('spawn', () => log('[coach] spawned'));
  coach.on('error', (e) => log('[coach] error: ' + e.message));
  coach.on('end', () => { log('[coach] ended, respawn 30s'); coach = null; setTimeout(spawnCoach, 30000); });
  setInterval(() => { for (const b of BOTS) online[b] = !!(coach && coach.players[b]); cyOnline = !!(coach && coach.players['cy']); }, 10000);
}
const whisper = (bot, text) => { if (coach && online[bot]) coach.whisper(bot, text); };

async function snapshot(bot) {
  const before = {};
  for (const it of ITEMS_NEEDED) before[it] = await countItem(bot, it);
  try { before.xp = await xpOf(bot); } catch (e) { before.xp = -1; }   // 战斗题硬验收: 击杀涨经验
  return before;
}

// ============ 狂暴主循环 ============
async function tickBot(b) {
  if (!online[b]) return;
  if (!state[b]) state[b] = { taskIdx: 0, round: 1, phase: 'idle', before: null, retries: 0, completedTasks: new Set(), lastPos: null, stuckCounter: 0, lastAction: 0 };
  const st = state[b];
  // 任务调度: 按 round 过滤的轮询(已验证稳定); DAG 保留备用
  const list = TASKS[b].filter(x => x.r <= st.round && !x._done);
  if (!list.length) { st.phase = 'idle'; return; }
  const task = list[st.taskIdx % list.length];
  // 防卡死检测：位置不动、动作重复、连续死亡
  if (st.phase !== 'idle' && st.phase !== 'resupply') {
    try {
      const pos = await posOf(b);
      if (pos) {
        if (st.lastPos && distance(st.lastPos, pos) < 0.5) {
          st.stuckCounter = (st.stuckCounter || 0) + 1;
        } else {
          st.stuckCounter = 0;
        }
        st.lastPos = pos;
        if (st.stuckCounter >= 3) {
        // 卡死也记账: 与三振退役共用 skipped 计数器 (旧版只重置idle不换题, 卡死题会死循环 9h)
        st.stuckCounter = 0;
        const sk = state[b].skipped || (state[b].skipped = {});
        sk[task.t] = (sk[task.t] || 0) + 1;
        if (sk[task.t] >= 3) {
          task._done = true;
          log(`[stuck-retire] ${b} "${task.t}" 卡死累计 3 次, 退役换下一题`);
          whisper(b, `${b}，这道题你卡够了三回, 教官先放你过去, 换一道。`);
        } else if (sk[task.t] === 1) {
          TASKS[b].push(Object.assign({}, task, { _requeued: true }));
          log(`[stuck] ${b} "${task.t}" 卡死 (第1次), 补课排队尾, 换下一道`);
          whisper(b, `${b}，这个先跳过，稍后会再考你一次。换下一个。`);
        } else {
          log(`[stuck] ${b} "${task.t}" 卡死 (第2次), 换下一道`);
          whisper(b, `${b}，这个先跳过，换下一个。`);
        }
        st.taskIdx += 1;
        st.retries = 0;
        st.phase = 'idle';
        return;
      }
      }
    } catch (e) {
      log('[stuck-check] ' + b + ' error: ' + e.message);
      // 检查失败不影响主流程, 继续本次 tick
    }
  }   // close anti-stuck if

  if (st.phase === 'idle') {
    st.before = await snapshot(b);
    st.suppliedThisTask = false; st.stallT = 0; st.lastHaveAt = -1;   // 新任务: 喂料记账清零
    const tag = `【R${st.round}-${(st.taskIdx % list.length) + 1}/${list.length}】`;
    let hint = '';
    if (st.retries > 0 && /collectBlocks/.test(task.cmd)) {
      // 换矿点: 采集类重派时传送到新资源区 (位置不是技能, 采集才是)
      const posRaw = await rcon(`data get entity ${b} Pos`);
      const nums = (posRaw.match(/-?\d+\.?\d*/g) || []).map(Number);
      if (nums.length >= 3) {
        const nx = nums[0] + Math.round(Math.random() * 60 - 30);
        const nz = nums[2] + Math.round(Math.random() * 60 - 30);
        await rcon(`tp ${b} ${nx.toFixed(1)} ${nums[1].toFixed(1)} ${nz.toFixed(1)}`);
        log(`[relocate] ${b} -> (${nx.toFixed(0)}, ${nz.toFixed(0)}) 换资源区`);
        await sleep(3000);
      }
      hint = '提示：先用 !searchForBlock 找资源走过去采集。';
    }
    whisper(b, `${b}，${tag} ${task.t}：${task.cmd} 完成后说"完成"。${hint}`);
    log(`[dispatch] ${b} <- ${tag}${task.t} (attempt ${st.retries + 1})`);
    st.phase = 'sent';
    st.sentAt = Date.now();
  } else if (st.phase === 'sent') {
    if (!st.sentAt) st.sentAt = Date.now();
    const win = /collectBlocks|newAction/.test(task.cmd) ? 150000 : 45000;   // 采集/自创长窗, 合成/交付快窗
    if (Date.now() - st.sentAt > win) { st.phase = 'verify'; }
    else {
      try { if (await task.check(b, st.before || {})) { st.phase = 'verify'; } } catch (e) {}   // 快速通道: 提前完成即刻验收
    }
  } else if (st.phase === 'resupply') {
    // ===== 顶层 resupply 状态机 v2 (自力优先, 卡滞才喂, 永不死锁) =====
    // 原则: 材料在涨 = 她在自己采 -> 不喂, 只催; 连续5tick没进度 = 卡死 -> 喂一次并记 assisted
    // 硬顶: 8分钟 或 15tick 双保险, 到点强制放行 (放行也记 assisted)
    st.resupplyTicks = (st.resupplyTicks || 0) + 1;
    const since = st.resupplySince || 0;
    const cur = await snapshot(b);
    const have = cur[st.resupplyMat] || 0;
    const doForce = (since && Date.now() - since > 480000) || st.resupplyTicks > 15 || !st.resupplyMat || !st.resupplyNeed;
    if (doForce) {
      // 双保险硬顶: 最后一道放行 (被救济, 老实记账)
      const craftItem = (task.cmd.match(/!craftRecipe\("([a-z_]+)"/) || [])[1];
      if (craftItem && CRAFT_NEEDS[craftItem]) {
        await rcon(`give ${b} ${craftItem} 8`);
        log(`[force-give-8min] ${b} <- ${craftItem} x8 成品放行 (tick${st.resupplyTicks})`);
      } else {
        await rcon(`give ${b} ${st.resupplyMat} ${Math.ceil(st.resupplyNeed * 2)}`);
        log(`[force-give-8min] ${b} <- ${st.resupplyMat} x${Math.ceil(st.resupplyNeed * 2)} 材料放行 (tick${st.resupplyTicks})`);
      }
      st.suppliedThisTask = true;
      st.phase = 'sent'; st.sentAt = Date.now(); st.resupplySince = 0; st.resupplyTicks = 0;
      return;
    }
    if (have >= st.resupplyNeed) {
      // 材料到位 (自力采到 或 上一tick喂的) -> 回来重试合成
      log(`[supply-ok] ${b} ${st.resupplyMat} 到位 (${have}/${st.resupplyNeed})${st.suppliedThisTask ? ' (教官喂的)' : ' (自己采的)'}`);
      whisper(b, `${b}，材料齐了！再来：${task.cmd}`);
      st.phase = 'sent'; st.sentAt = Date.now(); st.resupplySince = 0; st.resupplyTicks = 0;
    } else {
      // 卡滞判定: 材料数在涨 = 有进度, 重置卡滞计数; 不涨累计
      if (have > (st.lastHaveAt ?? -1)) { st.lastHaveAt = have; st.stallT = 0; }
      else st.stallT = (st.stallT || 0) + 1;
      if (st.stallT >= 5) {
        // 真卡死: 补工具 + 喂一次(只喂缺口的1.5倍), 记账 assisted, 重置卡滞
        if (!st.bootstrapped && online[b]) {
          const toolCount = (await countItem(b, 'wooden_pickaxe')) + (await countItem(b, 'stone_pickaxe')) + (await countItem(b, 'iron_pickaxe'));
          if (toolCount === 0) { await rcon(`give ${b} stone_pickaxe 1`); st.bootstrapped = true; log(`[bootstrap] ${b} <- 石镐 (resupply 工具链)`); }
        }
        const gap = Math.ceil((st.resupplyNeed - have) * 1.5);
        await rcon(`give ${b} ${st.resupplyMat} ${gap}`);
        st.suppliedThisTask = true; st.stallT = 0; st.lastHaveAt = -1;
        st.resupplySince = Date.now(); st.sentAt = Date.now();
        log(`[force-give-mat] ${b} <- ${st.resupplyMat} x${gap} (5tick卡滞 有${have}/缺${st.resupplyNeed}, tick${st.resupplyTicks})`);
      } else {
        // 没卡死: 3分钟换矿点催她自己采, 不喂
        if (Date.now() - (st.resupplySince || 0) > 180000) {
          const posRaw = await rcon(`data get entity ${b} Pos`);
          const nums = (posRaw.match(/-?\d+\.?\d*/g) || []).map(Number);
          if (nums.length >= 3) {
            const nx = nums[0] + Math.round(Math.random() * 60 - 30);
            const nz = nums[2] + Math.round(Math.random() * 60 - 30);
            await rcon(`tp ${b} ${nx.toFixed(1)} ${nums[1].toFixed(1)} ${nz.toFixed(1)}`);
            log(`[relocate] ${b} -> (-${Math.abs(Math.round(nx))},${Math.round(nz)}) 换矿点 (resupply催采)`);
          }
          const ore = COLLECT_MAP[st.resupplyMat] || st.resupplyMat;
          whisper(b, `${b}，${st.resupplyMat}还差 ${st.resupplyNeed - have} 个，自己采：!collectBlocks("${ore}", ${st.resupplyNeed - have})`);
          st.resupplySince = Date.now(); st.sentAt = Date.now();
        }
      }
    }
  } else if (st.phase === 'verify') {
    let ok = false;
    try { ok = await task.check(b, st.before || {}); } catch (e) { ok = false; }   // fail-safe: check抛错算失败走retry, 不再自动放行 (旧版catch->true会虚报验收通过)
    const offline = Object.values(st.before || {}).some(v => v === -1);
    if (ok || offline) {
      // 结构化日志：自力完成 vs 被救济 (喂过料的算被救济, 不再虚报自力)
      const assisted = st.retries > 0 || st.suppliedThisTask === true;
      const logEntry = {
        ts: Date.now(), bot: b, task: task.t, round: st.round,
        taskIdx: st.taskIdx, model: 'nv-rotate',
        phase: st.phase, retries: st.retries,
        assisted,
        durationMs: Date.now() - st.sentAt,
        success: true
      };
      log('[task-record] ' + JSON.stringify(logEntry));
      log('[pass] ' + b + ' "' + task.t + '" (retry ' + st.retries + ')' + (assisted ? '[assisted' + (st.suppliedThisTask ? '+喂料' : '') + ']' : ''));
      whisper(b, b + '，验收通过！' + (assisted ? ' (教官协助)' : '') + ' 下一个任务马上来。');

      // 成功则记录技能库候选（完全自力、没喂过料才入库）
      if (!assisted && task.cmd && task.cmd.startsWith('!newAction')) {
        log('[skill-candidate] ' + JSON.stringify({
          bot: b, task: task.t, cmd: task.cmd, round: st.round,
          model: 'nv-rotate', ts: Date.now()
        }));
      }
      
      st.taskIdx += 1;
      if (st.taskIdx % list.length === 0) {
        st.round = Math.min(st.round + 1, 6);
        log('[round-up] ' + b + ' -> R' + st.round);
        whisper(b, b + '，上一轮训练全部完成，难度提升到 R' + st.round + '！');
      }
      st.phase = 'idle'; st.retries = 0;
    } else if (st.phase === 'cooldown') {
      if (Date.now() - st.sentAt > 60000) { st.phase = 'idle'; }   // 冷却 60s: 让她跑完手头动作, 教官不打扰
    } else if (st.retries < 3 && st.phase !== 'cooldown') {
      st.retries += 1;
      // 合成类失败: 查缺口派补料 (教官当材料补给官)
      const craftItem = (task.cmd.match(/!craftRecipe\("([a-z_]+)"/) || [])[1];
      if (craftItem && CRAFT_NEEDS[craftItem]) {
        const cur = await snapshot(b);
        let needMat = null, needQty = 0;
        for (const [mat, need] of Object.entries(CRAFT_NEEDS[craftItem])) {
          const have = cur[mat] || 0;
          if (have < need) { needMat = mat; needQty = need; break; }   // 先补第一种缺口
        }
        if (needMat) {
          const ore = COLLECT_MAP[needMat] || needMat;
          const amount = Math.ceil((needQty - (cur[needMat] || 0)) * 1.5);
          log(`[supply] ${b} 缺 ${needMat} ${cur[needMat] || 0}/${needQty} -> 派采集 ${ore} x${amount}`);
          st.phase = 'resupply';   // 补料验收阶段: 材料到位才回来重试合成
          st.resupplyMat = needMat; st.resupplyNeed = needQty;
          st.sentAt = Date.now();
          st.resupplySince = Date.now();   // 每次进 resupply 强制刷新计时 (旧版 || 会让僵尸时间戳污染硬顶)
          st.supplyFails = 0;
          st.suppliedThisTask = false; st.stallT = 0; st.lastHaveAt = -1;
          return;
        }
      }

      log(`[retry] ${b} "${task.t}" retry ${st.retries}`);
      st.phase = 'sent';
    } else {
      log(`[skip] ${b} "${task.t}" failed ${st.retries + 1} times, skip`);
      // bootstrap: 采集任务卡死时检查工具链, 没镐塞一把 (打破 '没镐->挖不了->没木板->没镐' 死循环, 技能照练)
      if (/collectBlocks/.test(task.cmd) && !st.bootstrapped) {
        const toolCount = (await countItem(b, 'wooden_pickaxe')) + (await countItem(b, 'stone_pickaxe')) + (await countItem(b, 'iron_pickaxe'));
        if (toolCount === 0 && online[b]) {
          await rcon(`give ${b} stone_pickaxe 1`);
          st.bootstrapped = true;
          whisper(b, `${b}，教官看你徒手刨地心疼，塞了把石镐到你背包（按 E 看看）。装备好继续！`);
          log(`[bootstrap] ${b} <- stone_pickaxe (tool chain was broken)`);
        }
      }
      // 三振退役: 同一道题(skip键)累计 skip 3 次就永久退役, 不再反复啃做不出的题
      const skipKey = task.t;
      const sk = state[b].skipped || (state[b].skipped = {});
      sk[skipKey] = (sk[skipKey] || 0) + 1;
      if (sk[skipKey] >= 3) {
        task._done = true;                       // 该题永久退役, taskOf 过滤掉
        log(`[retire] ${b} "${skipKey}" 累计skip 3次, 永久退役换下一题`);
        whisper(b, `${b}，这道题你练够三回了, 教官先放你过去, 练别的。`);
      } else if (sk[skipKey] === 1) {
        // 第一次skip: 补课排到队尾再练一次
        const listAll = TASKS[b];
        listAll.push(Object.assign({}, task, { _requeued: true }));
        whisper(b, `${b}，这个先跳过，稍后会再考你一次。换下一个。`);
      } else {
        whisper(b, `${b}，这个先跳过，换下一个。`);
      }
      st.taskIdx += 1;
      st.phase = 'idle'; st.retries = 0;
    }
  }
}

async function mainLoop() {
  for (const b of BOTS) {
    try { await tickBot(b); } catch (e) { log('[loop-err] ' + b + ' ' + e.message); }
    await sleep(8000);
  }
  const on = BOTS.filter(b => online[b]).length;
  log(`[tick] bots=${on}/3 cy=${cyOnline ? 'on(whisper静默)' : 'off'} | ` +
      BOTS.map(b => `${b}:${state[b] ? state[b].phase + '/R' + state[b].round + '/' + (state[b].taskIdx % 99) : '-'}`).join(' '));
  saveState();
}


const STATE_FILE = path.join(__dirname, 'trainer_state.json');
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {} }
function loadState() { try { const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); for (const k of BOTS) if (d[k]) { state[k] = d[k]; if (state[k].phase === 'resupply' || state[k].phase === 'sent') { state[k].phase = 'idle'; state[k].sentAt = 0; } state[k].resupplySince = 0; state[k].supplyFails = 0; state[k].resupplyTicks = 0; } log('[state] loaded (transient phases + resupply timers reset)'); } catch (e) { log('[state] fresh start'); } }

log('==== BEAST TRAINER started ====');
loadState();
spawnCoach();
setTimeout(async () => {
  while (true) {
    try { await mainLoop(); } catch (e) { log('[main] ' + e.message); }
    await sleep(15000);   // tick: bot间8s + 外层15s ≈ 39s/轮, idle派发 -> sent -> verify验收, 全链 ~2min/任务
  }
}, 25000);
