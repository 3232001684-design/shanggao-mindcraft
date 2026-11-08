import { appendFileSync as __fsAppendFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
globalThis.__fsAppend = (f, s) => { try { __fsAppendFileSync(f, s); } catch (e) {} };
import { Vec3 } from 'vec3';
import { History } from './history.js';
import { Coder } from './coder.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer, sendLogToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { getKey } from '../utils/keys.js';
import * as skills from './library/skills.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._events = [];          // [mc-instructor] 真实事件环: 受伤/死亡/捡到/上下线
        this._lastHealth = null;
        this._lastUserChat = 0;     // [mc-instructor] 上次老公说话时间(用于抑制自言自语)
        this._lastIdleMsg = '';     // [mc-instructor] 上次自言自语内容(去重)

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        try { this.bot.setMaxListeners && this.bot.setMaxListeners(30); } catch (e) {}
        try {
            const _dig = this.bot.dig.bind(this.bot);
            this.bot.dig = async (block, forceLook, digFace) => {
                try { if (block) await this.bot.tool.equipForBlock(block); } catch (e) {}
                return _dig(block, forceLook, digFace);
            };
        } catch (e) {}
        setTimeout(() => {
            try {
                const off = ['cowardice', 'hunting', 'item_collecting', 'torch_placing', 'idle_staring', 'cheat', 'elbow_room', 'self_defense'];
                for (const n of off) if (this.bot.modes?.exists?.(n)) this.bot.modes.setOn(n, false);
                console.log('[mc-instructor] 自动模式已关:', off.join(','));
            } catch (e) {}
        }, 3000);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // [mc-instructor] 皮肤由服务端 SkinsRestorer 统一管理(sr set), 登录时不要再 /skin clear 抹掉
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                const viewer = await addBrowserViewer(this.bot, count_id);
                if (viewer.error) {
                    serverProxy.getSocket()?.emit('viewer-status', this.name, { error: viewer.error });
                    sendOutputToServer(this.name, `Viewer unavailable: ${viewer.error}`);
                }
                console.log('Initializing vision intepreter...');
                // VisionInterpreter -> camera.js -> node-canvas-webgl, whose native
                // deps (gl, canvas) are optionalDependencies and may not have built.
                // Import lazily so the bot still works without screenshot vision.
                try {
                    const { VisionInterpreter } = await import('./vision/vision_interpreter.js');
                    this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);
                } catch (e) {
                    console.warn('Vision module unavailable (optional native deps not built):', e.message);
                    this.vision_interpreter = null;
                }

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        // [mc-instructor] 真实事件采集 (喂养 perception, 让老婆知道刚刚发生了什么)
        this.bot.on('health', () => {
            try {
                if (this._lastHealth != null && this.bot.health < this._lastHealth)
                    this._pushEvent(`受伤: 生命 ${Math.round(this._lastHealth)}→${Math.round(this.bot.health)}`);
                this._lastHealth = this.bot.health;
            } catch (e) {}
        });
        this.bot.on('entityHurt', (entity) => { try { if (entity === this.bot.entity) this._pushEvent('你被打了'); } catch (e) {} });
        this.bot.on('death', () => this._pushEvent('你死了, 已经复活'));
        this.bot.on('playerJoined', p => { try { if (p.username !== this.name) this._pushEvent(p.username + ' 上线'); } catch (e) {} });
        this.bot.on('playerLeft', p => { try { if (p.username !== this.name) this._pushEvent(p.username + ' 下线'); } catch (e) {} });
        this.bot.on('playerCollect', (collector) => { try { if (collector && collector.username === this.name) this._pushEvent('你捡到了东西'); } catch (e) {} });


        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }


    _pushEvent(text) {
        try {
            this._events = this._events || [];
            const t = new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
            this._events.push(t + ' ' + text);
            if (this._events.length > 12) this._events.shift();
        } catch (e) {}
    }

    perception() {
        try {
            const bot = this.bot;
            if (!bot || !bot.entity) return '【感知】还没连上世界';
            const pos = bot.entity.position;
            const R = (n, d = 0) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '?');
            const L = [];
            const tod = bot.time?.timeOfDay ?? 0;
            const phase = tod < 6000 ? '早晨' : tod < 12000 ? '下午' : tod < 18000 ? '夜晚' : '深夜';
            const weather = (bot.thunderState > 0) ? '雷雨' : (bot.rainState > 0 ? '下雨' : '晴');
            const dim = String(bot.game?.dimension || '').replace('minecraft:', '');
            const dimZh = dim === 'overworld' ? '主世界' : dim === 'the_nether' ? '下界' : dim === 'the_end' ? '末地' : dim;
            L.push('【此刻真实感知 · 代码采集, 绝对真实, 别猜】');
            L.push(`时间: ${phase}(${tod}) 天气: ${weather} 维度: ${dimZh}`);
            L.push(`位置: (${R(pos.x,1)}, ${R(pos.y,1)}, ${R(pos.z,1)}) 脚下: ${bot.blockAt(pos.offset(0,-1,0))?.name || '?'} 卡住: ${bot.entity.isCollidedHorizontally ? '是' : '否'} 在水里: ${bot.entity.isInWater ? '是' : '否'}`);
            const armor = [5,6,7,8].map(i => bot.inventory?.slots?.[i]?.name).filter(Boolean);
            L.push(`身体: 生命 ${Math.round(bot.health)}/20 饥饿 ${Math.round(bot.food)}/20 护甲: ${armor.length ? armor.join(',') : '无'} 经验 ${bot.experience?.level ?? 0}级`);
            L.push(`手持: ${bot.heldItem ? bot.heldItem.name + 'x' + bot.heldItem.count : '空手'}`);
            L.push(`正在做: ${this.actions?.currentActionLabel || '发呆'}${this.actions?.executing ? '(执行中)' : ''}${bot.pathfinder?.isMoving?.() ? ' 正在走路' : ''}`);
            if (this._cmdLog && this._cmdLog.length) L.push('【最近真正的动作结果】' + this._cmdLog.slice(-3).join(' | '));
            const me = bot.players?.['cy'];
            if (me && me.entity) {
                const d = Math.round(pos.distanceTo(me.entity.position));
                const dy = Math.round(me.entity.position.y - pos.y);
                L.push(`老公cy: 在线, 距离${d}格${dy > 2 ? ' 在你上方' : dy < -2 ? ' 在你下方' : ''}`);
            } else {
                L.push('老公cy: 不在附近/不在线');
            }
            const others = [];
            for (const [name, p] of Object.entries(bot.players || {})) {
                if (name === this.name || !p.entity) continue;
                others.push(`${name} ${Math.round(pos.distanceTo(p.entity.position))}格`);
            }
            if (others.length) L.push(`附近玩家: ${others.join(', ')}`);
            const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|bogged|creeper|spider|cave_spider|witch|pillager|vindicator|evoker|ravager|phantom|slime|magma_cube|blaze|ghast|wither_skeleton|piglin|piglin_brute|hoglin|zoglin|warden|enderman|endermite|silverfish|guardian|elder_guardian|shulker|breeze|zombified_piglin|vex)$/;
            const mobs = [];
            for (const e of Object.values(bot.entities || {})) {
                const nm = String(e.name || '').replace('minecraft:', '');
                if (!nm || e === bot.entity || ['item','player','armor_stand','experience_orb','area_effect_cloud','arrow','marker','item_frame','painting','boat','minecart'].includes(nm)) continue;
                const dd = pos.distanceTo(e.position);
                if (dd > 20) continue;
                mobs.push({ nm, dd: Math.round(dd), hostile: HOSTILE.test(nm) });
            }
            mobs.sort((a, b) => a.dd - b.dd);
            if (Math.random() < 0.12) console.log('[percept] mobs', mobs.length, mobs.slice(0,3).map(m => m.nm).join(','));
            if (mobs.length) {
                L.push(`附近生物: ${mobs.slice(0, 8).map(m => `${m.nm}(${m.dd}格${m.hostile ? ',危险' : ''})`).join(', ')}`);
                const hostile = mobs.filter(m => m.hostile);
                if (hostile.length) L.push(`威胁: ${hostile.length}只敌对, 最近 ${hostile[0].nm} ${hostile[0].dd}格`);
            } else {
                L.push('附近生物: 没有');
            }
            const around = new Set();
            for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[0,2],[-2,0],[0,-2]]) {
                const b = bot.blockAt(pos.offset(dx, 0, dz)); if (b && b.name !== 'air') around.add(b.name);
                const b2 = bot.blockAt(pos.offset(dx, -1, dz)); if (b2 && b2.name !== 'air') around.add(b2.name);
            }
            try {
                const feet = bot.blockAt(pos.offset(0, -1, 0));
                const head = bot.blockAt(pos.offset(0, 1, 0));
                let drop = -1;
                for (let i = 1; i <= 10; i++) { const b = bot.blockAt(pos.offset(0, -i, 0)); if (b && b.boundingBox === 'block') { drop = i - 1; break; } }
                const onTree = feet && /(leaves|_log|_wood)$/.test(feet.name);
                let flat = true;
                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                    const g = bot.blockAt(pos.offset(dx, -1, dz));
                    const a = bot.blockAt(pos.offset(dx, 0, dz));
                    if (!g || g.boundingBox !== 'block' || !a || a.boundingBox === 'block') { flat = false; break; }
                }
                L.push(`地形: 脚下${feet ? feet.name : '?'}${onTree ? '(站在树上,这不算空地!)' : ''} 头顶${head ? head.name : '?'} 离下方实地${drop < 0 ? '很深' : drop + '格'} 周围3x3平地:${flat ? '是' : '否'}`);
            } catch (e) {}
            if (around.size) L.push(`周围方块: ${[...around].slice(0, 10).join(', ')}`);
            try {
                const seen = new Set(); const marks = [];
                const found = bot.findBlocks({ matching: (b) => b && /(_bed|crafting_table|furnace|chest|torch|_door|anvil|brewing_stand|water|lava)$/.test(b.name), maxDistance: 12, count: 60 });
                for (const p2 of found) {
                    const b = bot.blockAt(p2); if (!b) continue;
                    const key = b.name; if (seen.has(key) && marks.length > 4) continue;
                    seen.add(key);
                    const d = Math.round(pos.distanceTo(p2));
                    marks.push(`${b.name} ${d}格(${p2.x},${p2.y},${p2.z})`);
                    if (marks.length >= 8) break;
                }
                if (marks.length) L.push(`身边可用方块: ${marks.join(', ')}`);
            } catch (e) {}

            const inv = {};
            for (const it of (bot.inventory?.items?.() || [])) inv[it.name] = (inv[it.name] || 0) + it.count;
            const invStr = Object.entries(inv).map(([k, v]) => `${k}x${v}`).join(', ');
            L.push(`背包(${36 - (bot.inventory?.emptySlotCount?.() ?? 36)}/36格): ${invStr || '空'}`);
            if (this._events?.length) L.push('最近发生:\n- ' + this._events.slice(-6).join('\n- '));
            return L.join('\n');
        } catch (e) {
            return '【感知】读取失败: ' + String(e?.message || e).slice(0, 80);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (source && source !== 'system' && source !== this.name) {
            this._lastSpeaker = source;
            if (source === 'cy' && this.bot.players['J.Dilla']) this._relay(message, 'ru', 'перевод: ', 'J.Dilla');
            if (/^(cy|probe)$/.test(String(source))) {
                const _t = String(message);
                if (/过来|来我|来这|跟着我|过来吧/.test(_t) && !/别|不/.test(_t)) {
                    this._mining = false; this._hunting = false; this._taskEpoch = (this._taskEpoch || 0) + 1;
                    try { this.actions.stop(); } catch (e) {}
                    skills.goToPlayer(this.bot, String(source), 3).catch(e => console.log('[come]', e.message));
                    return true;
                }
                if (/存东西|放箱子|收进箱子|整理背包|放进箱子/.test(_t)) {
                    this._mining = false; this._hunting = false;
                    console.log('[chest] store start');
                    const m = await this._chestStore(_t).catch(e => { console.log('[chest] err', e.message); return '出错'; });
                    console.log('[chest] store done', m);
                    try { this.bot.chat('老公，' + m + '。'); } catch (e) {}
                    return true;
                }
                if (/从箱子|拿点|箱子里|取点/.test(_t)) { this._chestTake(_t).then(m => { try { this.bot.chat('老公，' + m + '。'); } catch (e) {} }).catch(() => {}); return true; }
                if (/别打|不打|停下|住手|跑|回来/.test(_t) && !/打怪/.test(_t)) this._hunting = false;
                else if (/打怪|杀怪|清怪|干掉|打死|揍它|帮我打/.test(_t)) {
                    if (!this._hunting) { this._hunting = true; this._huntLoop().catch(() => {}); console.log('[hunt] start'); }
                }
                if (/别挖|停一下|停下来|上来|回来|别干了/.test(_t)) this._mining = false;
                else if (/挖矿|继续挖|一起挖|矿道|往下挖|挖吧/.test(_t)) {
                    if (!this._mining) { this._mining = true; this._mineLoop().catch(() => {}); console.log('[mine] start'); }
                }
            }
            if (/^(cy|probe)$/.test(String(source)) && /(给我|拿来|要|整点|弄点|做点|东西呢|好了没|之前的|一套|资源)/.test(String(message)) && /(石|木|装备|武器|火把|剑|镐|稿|斧|东西|资源|甲)/.test(String(message))) {
                console.log('[supply] request from', source, String(message).slice(0, 30));
                const _ok = await this._supply(String(message), String(source)).catch(e => { console.error('[supply] err', e.message); return false; });
                console.log('[supply] result', _ok);
                if (_ok) { console.log('[supply] handled'); return true; }
            }
            if (source !== 'cy' && source !== 'coach' && this.bot.players['cy']) this._relay(message, 'zh', '【译】', 'cy');
            if (source === 'J.Dilla' && this.bot.players['J.Dilla']) message = String(message) + ' (用俄语回他, 简短一句)';
            this._awaitingReply = true;
            this._lastReplyAt = this._lastReplyAt || 0;
            const quiet = Date.now() - this._lastReplyAt < 1500;
            const named = /老婆|DeepSeek|deepseek|дипсик|дипси|Дипсик|翻译|过来|帮我|来一下/.test(String(message));
            if (quiet && !named) { console.log('[mc-instructor] 连续发言节流, 跳过:', String(message).slice(0, 20)); return false; }
        }
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        if (source === 'system' || source === this.name) { this._awaitingReply = !!this._idlePrompt; this._idlePrompt = false; }
        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);
        if (!self_prompt && !from_other_bot) this._lastUserChat = Date.now();

        if ((!self_prompt || source === 'system') && !from_other_bot) { // from user, or system init_message, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);
        sendLogToServer(this.name, self_prompt ? 'thinking' : 'user', `${source}: ${message}`);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        const _who = source === 'cy' ? 'cy(你老公)' : (source === this.name ? '你自己' : source + '(朋友)');
        if (source && source !== 'system' && source !== this.name) {
            const _other = source === 'cy' ? 'J.Dilla' : 'cy';
            if (new RegExp('^\s*' + _other + '\b|^\s*@' + _other, 'i').test(message) && !/ds|дипси|deepseek|老婆/i.test(message)) {
                console.log('[mc-instructor] 这句是跟别人说的, 不接话');
                this._awaitingReply = false;
                return false;
            }
            message = `[现在对你说话的是 ${_who}; 只回他, 不要替另一个人接话。] ` + message;
        }
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history, self_prompt ? 'auto' : 'chat');

            // === 语言硬过滤: 俄语/英文漂移自动重生成中文 ===
            try {
                const hasCyrillic = /[Ѐ-ӿ]/.test(res || '');
                const hasChinese = /[一-龥]/.test(res || '');
                // 英文散文泄漏: 无中文 + 含英文功能词。命令/物品名(如 !collectBlocks("oak_log",6))
                // 不含 the/they/because 这类功能词, 故不会误伤; 只有模型真写了英文句子才触发
                const ENG_FN = /\b(the|they|them|their|these|those|which|what|where|when|who|whose|have|has|had|is|are|was|were|be|been|doing|would|could|should|might|must|shall|will|need|want|because|since|although|though|then|also|very|really|just|only|not|own|some|any|each|every|both|few|more|most|other|such|its|them)\b/i;
                const hasEnglishProse = ENG_FN.test(res || '');
                if (!hasChinese && (hasCyrillic || hasEnglishProse)) {
                    console.log('[mc-instructor] 语言漂移(' + (hasCyrillic ? '俄语' : '英语') + ') -> 强制重生成中文');
                    this.history.add('system', '你刚才没用中文回答。规则: 你必须始终用中文回答, 禁止使用俄语/英语。请用中文重新回答。');
                    const res2 = await this.prompter.promptConvo(this.history.getHistory(), self_prompt ? 'auto' : 'chat');
                    if (res2 && /[一-龥]/.test(res2)) {
                        res = res2;
                        console.log('[mc-instructor] 中文重生成成功');
                    } else if (res2) {
                        res = res2;
                    }
                }
            } catch (e) { console.warn('[lang-filter]', e.message); }

            console.log(`${this.name} full response to ${source}: ""${res}""`);
            sendLogToServer(this.name, 'thinking', res);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res;
                if (source && !/^(cy|probe|coach)$/.test(String(source)) && source !== 'system' && source !== this.name) {
                    execute_res = 'Action output: (chat only, no action)';
                } else {
                    execute_res = await executeCommand(this, res);
                }

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                try {
                    this._cmdLog = this._cmdLog || [];
                    const brief = execute_res ? String(execute_res).replace(/\s+/g, ' ').slice(0, 80) : '没有返回(被中断或没执行完)';
                    this._cmdLog.push(command_name + ' -> ' + brief);
                    if (this._cmdLog.length > 4) this._cmdLog.shift();
                } catch (e) {}
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }


    _relay(text, lang, prefix, target) {
        try {
            if (!text || String(text).trim().length < 2 || /!/.test(String(text).slice(0, 3))) return;
            if (this.name !== 'DeepSeek') return;   // 翻译只由主 bot 做, 防多 bot 重复刷屏
            const key = process.env.NVIDIA_API_KEY || getKey('NVIDIA_API_KEY');
            if (!key) return;
            if (lang === 'ru') text = String(text).replace(/老公/g, 'cy').replace(/老婆/g, 'DeepSeek');
            const sys = lang === 'ru'
                ? 'Переведи текст на русский. Только перевод, без пояснений и кавычек.'
                : '把这段外语翻成简短自然的中文, 只给译文, 不要解释。';
            this._relayQ = (this._relayQ || Promise.resolve()).then(async () => {
                try {
                    console.log('[relay] send', lang, String(text).slice(0,20));
                    const r = await fetch('http://127.0.0.1:18899/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                        body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b', messages: [{ role: 'system', content: sys }, { role: 'user', content: String(text).slice(0, 500) }], max_tokens: 220, temperature: 0, enable_thinking: false }),
                        signal: AbortSignal.timeout(15000)
                    });
                    const j = await r.json();
                    let t = j?.choices?.[0]?.message?.content?.trim();
                    if (!t) return;
                    t = t.split(String.fromCharCode(10)).join(' ').slice(0, 240);
                    if (target && this.bot.players[target]) this.bot.whisper(target, prefix + t);
                    else this.bot.chat(prefix + t);
                } catch (e) { console.error('[relay]', e.message); }
            });
        } catch (e) { console.error('[relay-outer]', e.message); }
    }


    async _chestStore(raw) {
        this._taskEpoch = (this._taskEpoch || 0) + 1;
        this._busyTask = true;
        try { this.actions.stop(); } catch (e) {}
        try { return await this._chestStoreImpl(raw); }
        finally { this._busyTask = false; }
    }

    async _chestStoreImpl(raw) {
        const b = this.bot;
        const keep = /(pickaxe|axe|shovel|sword|torch|bread|beef|porkchop|potato|apple|cooked)/;
        const names = [...new Set(b.inventory.items().map(i => i.name))].filter(n => !keep.test(n));
        if (!names.length) return 'nothing to store';
        let stored = 0;
        const homes = [[-24, 72, -42], [-24, 72, -41]];
        let chest = null;
        for (const [x, y, z] of homes) {
            const blk = b.blockAt(new Vec3(x, y, z));
            if (blk && blk.name === 'chest') { chest = blk; break; }
        }
        if (chest) {
            try {
                await skills.goToPosition(b, chest.position.x, chest.position.y, chest.position.z, 2).catch(() => {});
                if (b.entity.position.distanceTo(chest.position) > 5) {
                    try { b.chat('/tp DeepSeek -23 72 -41'); } catch (e) {}
                    await new Promise(r => setTimeout(r, 2500));
                }
                let c;
                try { c = await b.openContainer(chest); }
                catch (e) {
                    console.log('[chest] first open failed, tp home');
                    try { b.chat('/tp DeepSeek -23 72 -41'); } catch (e2) {}
                    await new Promise(r => setTimeout(r, 2500));
                    c = await b.openContainer(chest);
                }
                for (const n of names) {
                    const it = b.inventory.items().find(i => i.name === n);
                    if (!it) continue;
                    try { await c.deposit(it.type, null, it.count); stored++; } catch (e) {}
                }
                await c.close();
            } catch (e) { console.log('[chest]', e.message); }
        }
        if (!stored) for (const n of names) {
            try { if (await skills.putInChest(b, n, -1)) stored++; } catch (e) {}
        }
        console.log('[chest] stored kinds', stored);
        return `存了 ${stored} 种东西`;
    }

    async _chestTake(raw) {
        const b = this.bot;
        const t = String(raw);
        const map = [['圆石','cobblestone'],['石头','stone'],['木头','oak_log'],['原木','oak_log'],['煤','coal'],['铁','iron_ingot'],['火把','torch'],['面包','bread'],['牛肉','cooked_beef'],['钻石','diamond']];
        let got = 0;
        for (const [zh, en] of map) {
            if (t.includes(zh)) {
                try { if (await skills.takeFromChest(b, en, 64)) got++; } catch (e) {}
            }
        }
        if (!got) {
            try { await b.chat('老公，箱子里要拿哪个？说个名字。'); } catch (e) {}
        }
        return `took ${got}`;
    }

    async _huntLoop() {
        return this.__huntLoopImpl();
    }

    async __huntLoopImpl() {
        const b = this.bot;
        const ep = (this._taskEpoch = (this._taskEpoch || 0) + 1);
        if (this._huntBusy) return;
        this._huntBusy = true;
        const BAD = /^(zombie|zombie_villager|skeleton|stray|husk|drowned|creeper|spider|cave_spider|witch|enderman|phantom|pillager|vindicator|ravager|slime|magma_cube|blaze|ghast|hoglin|zoglin|piglin_brute)$/;
        try {
            try {
                const sword = b.inventory.items().find(i => /_sword$/.test(i.name));
                if (sword) await b.equip(sword, 'hand');
            } catch (e) {}
            while (this._hunting && b.entity && ep === this._taskEpoch) {
                if (this._busyTask) { await new Promise(r => setTimeout(r, 1000)); continue; }
                if (b.health !== undefined && b.health <= 6) { console.log('[hunt] low hp, stop'); try { this.bot.chat('老公，我血不多了，先撤。'); } catch (e) {} break; }
                const mob = b.nearestEntity(e => e.type === 'hostile' || (e.type === 'mob' && BAD.test(e.name || '')) || (e.type === 'mob' && BAD.test(e.name || '')));
                if (!mob) { await new Promise(r => setTimeout(r, 2000)); continue; }
                const d = mob.position.distanceTo(b.entity.position);
                console.log('[hunt] target', mob.name, d.toFixed(1));
                try { await skills.attackEntity(b, mob, true); } catch (e) { await new Promise(r => setTimeout(r, 800)); }
            }
        } finally { this._huntBusy = false; console.log('[hunt] stop'); }
    }

    async _mineLoop() {
        const b = this.bot;
        const ep = (this._taskEpoch = (this._taskEpoch || 0) + 1);
        if (this._mineBusy) return;
        this._mineBusy = true;
        let n = 0;
        try {
            while (this._mining && b.entity && n < 400 && ep === this._taskEpoch) {
                if (this._busyTask) { await new Promise(r => setTimeout(r, 1000)); continue; }
                n++;
                try {
                    const ore = b.findBlock({ matching: (bl) => /(_ore|ancient_debris)$/.test(bl.name), maxDistance: 24 });
                    if (ore) {
                        const d = ore.position.distanceTo(b.entity.position);
                        console.log('[mine] ore', ore.name, d.toFixed(1));
                        if (d <= 5.5) { try { await b.dig(ore, true); } catch (e) { await skills.collectBlock(b, ore.name, 1); } }
                        else await skills.collectBlock(b, ore.name, 1);
                    } else await skills.collectBlock(b, 'stone', 4);
                } catch (e) {
                    console.log('[mine] retry', e.message);
                    await new Promise(r => setTimeout(r, 2500));
                }
            }
        } finally {
            this._mineBusy = false;
            console.log('[mine] stop after', n);
        }
    }

    async _supply(raw, target = 'cy') {
        const b = this.bot;
        const text = String(raw).replace(/石稿/g, '石镐').replace(/稿子/g, '镐子');
        if (this._supplyBusy) { this._supplyQueued = raw; return true; }
        this._supplyBusy = true;
        try { return await this._supplyRun(text, target); }
        finally { this._supplyBusy = false; const q = this._supplyQueued; this._supplyQueued = null; if (q) setTimeout(() => this._supply(q).catch(() => {}), 800); }
    }

    async _supplyRun(text, target = 'cy') {
        const b = this.bot;
        this._mining = false; this._hunting = false;
        this._taskEpoch = (this._taskEpoch || 0) + 1;
        this._busyTask = true;
        try { this.actions.stop(); } catch (e) {}
        const count = (n) => b.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0);
        const wants = [];
        const add = (n, c) => { if (!wants.find(w => w[0] === n)) wants.push([n, c]); };
        if (/三件套|石器|装备|武器/.test(text)) { add('stone_sword', 1); add('stone_pickaxe', 1); add('stone_axe', 1); }
        if (/剑/.test(text)) add('stone_sword', 1);
        if (/镐/.test(text)) add('stone_pickaxe', 1);
        if (/斧/.test(text)) add('stone_axe', 1);
        if (/木头|原木|树/.test(text)) add('oak_log', 16);
        if (/石头|圆石|石料/.test(text)) add('cobblestone', 32);
        if (/一组.*火把|火把.*一组/.test(text)) add('torch', 64);
        else if (/火把/.test(text)) add('torch', 16);
        if (!wants.length || /之前|一套|资源|装备|东西/.test(text)) { add('iron_sword', 1); add('iron_pickaxe', 1); add('iron_axe', 1); add('cooked_beef', 8); add('torch', 16); add('cobblestone', 32); add('oak_log', 16); }
        this._allowSpeakUntil = Date.now() + 60000;
        this._awaitingReply = true;
        const given = [];
        for (const [name, num] of wants) {
            let have = count(name);
            if (have < num && /_(sword|pickaxe|axe|shovel|hoe)$/.test(name)) {
                try {
                    if (/pickaxe|sword/.test(name) && count('cobblestone') < 3) await skills.collectBlock(b, 'stone', 4).catch(() => {});
                    if (/axe|pickaxe|sword|shovel|hoe/.test(name) && count('stick') < 2) {
                        if (count('oak_planks') < 1 && count('oak_log') > 0) await skills.craftRecipe(b, 'oak_planks', 1).catch(() => {});
                        await skills.craftRecipe(b, 'stick', 4).catch(() => {});
                    }
                } catch (e) {}
                try { await skills.craftRecipe(b, name, num - have); } catch (e) { console.log('[supply] craft fail', name, e.message); }
                have = count(name);
                if (have < num) {
                    try { await skills.craftRecipe(b, 'stick', 4); } catch (e) {}
                    try { await skills.craftRecipe(b, name, num - have); } catch (e) {}
                    have = count(name);
                }
                if (have < num && count('cobblestone') > 0) {
                    await skills.giveToPlayer(b, 'cobblestone', target, Math.min(count('cobblestone'), 16)).catch(() => {});
                }
            }
            if (have < num && (name === 'oak_log' || name === 'cobblestone' || name === 'torch')) {
                const block = name === 'oak_log' ? 'oak_log' : name === 'cobblestone' ? 'stone' : null;
                if (block) {
                    try { await skills.collectBlock(b, block, Math.max(1, Math.ceil((num - have) / 2))); } catch (e) {}
                } else if (name === 'torch') {
                    const coal = count('coal');
                    if (coal >= 1 && count('stick') + count('oak_planks') > 0) await skills.craftRecipe(b, 'torch', num).catch(() => {});
                }
                have = count(name);
            }
            if (have > 0) { const _give = Math.min(num, have); if (await skills.giveToPlayer(b, name, target, _give).catch(() => false)) given.push(name.replace('minecraft:','') + ' ' + _give); }
        }
        const left = given.length ? given.join(', ') : '空手';
        if (!given.length) { try { this.bot.chat(target === 'cy' ? '老公，我这儿没现成的，等我弄好了给你。' : 'пока нет, сделаю позже'); } catch (e) {} return true; }
        setTimeout(() => { try { this.bot.chat(target === 'cy' ? ('老公，东西给你了：' + left + '，捡一下。') : ('вот, забирай: ' + left)); } catch (e) {} }, 500);
        return true;
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim(); // [mc-instructor] 命令静默: 只播人话, 命令已执行不刷公屏
        // [mc-instructor] action guard: 说'去干嘛/找到了'但没带命令 -> 12s后没位移就自动催
        if (!containsCommand(message) && /(我去|找到了|去看看|去前面|去看看|我来拿|这就去)/.test(message)) {
            const posBefore = this.bot.entity ? this.bot.entity.position.clone() : null;
            setTimeout(() => {
                try {
                    if (!posBefore || !this.bot.entity) return;
                    const moved = this.bot.entity.position.distanceTo(posBefore);
                    if (moved < 2) {
                        this.handleMessage('system', '(你嘴上说要去/找到了, 但人没动: 现在立刻发 !goToPlayer 走到老公身边, 或 !goToCoordinates 去你说的地方)', -1).catch(() => {});
                    }
                } catch (e) {}
            }, 12000);
        }
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        // [mc-instructor] 重复台词 90s 内不再刷屏
        if (this._lastChatMsg === message.trim() && Date.now() - (this._lastChatAt || 0) < 90000) {
            console.log('[mc-instructor] 重复台词, 跳过:', message.slice(0, 20));
            return;
        }
        this._lastChatMsg = message.trim();
        this._lastChatAt = Date.now();
        const _gapMs = Date.now() - (this._lastSentAt || 0);
        if (_gapMs < 10000) await new Promise(r => setTimeout(r, 10000 - _gapMs));
        this._lastSentAt = Date.now();
        this._lastReplyAt = Date.now();
        message = message.replaceAll('\n', ' ');
        message = message.replace(/```[\s\S]*?```/g, ' ').replace(/```/g, ' ');
        if (/#include|struct\s+\w+\s*\{|public\s+static|console\.log|def\s+\w+\(|function\s+\w+\(|Vec3|for\s*\(\s*int|float\s+\w+/.test(message) || message.length > 240) {
            message = '老公，代码太长，公屏贴不下，回头单独给你。';
        }

        if (this._lastSpeaker && this._lastSpeaker !== 'cy' && /[Ѐ-ӿ]/.test(message)) {
            const _segs = message.split(/(?<=[.!?。])\s*/).filter(x => !/[一-龥]/.test(x));
            const _ru = _segs.join(' ').trim();
            if (_ru.length > 2) message = _ru;
        }
        if (/系统|命令|背包数据|newAction|Action output|报错|Error|undefined|settings/.test(message)) {
            console.log('[mc-instructor] 屏蔽技术黑话:', message.slice(0, 30));
            return;
        }
        message = message.split(/(?<=[。！？!?])\s*/).filter(x => x.trim()).slice(0, 2).join(' ');
        if (message.length > 70) message = message.slice(0, 68) + '…';
        const _gap = Date.now() - (this._lastSentAt || 0);
        if (_gap < 4000) await new Promise(r => setTimeout(r, 4000 - _gap));
        this._awaitingReply = false;
        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
            if (this.bot.players['cy'] && /[Ѐ-ӿ]/.test(message) && !/^\[/.test(message)) this._relay(message, 'zh', '【译】', 'cy');
            console.log('[mirror] try', this.bot.players['J.Dilla'] ? 'friend-on' : 'friend-off', message.slice(0,20));
        }
    }

    startEvents() {
        // [mc-instructor] idleChat 单驱动(小模型语境纯净): 闲聊+行动都由 15-90s 注入触发
        // [mc-instructor] 实时感知: 每个 idleChat 收一份"当下状况快照"随消息注入 (只在她空闲时, 不打断任务, 全程 try/catch 防 bug)
        const situation = () => {
            try {
                const pos = this.bot.entity.position;
                const light = typeof this.bot.levelLightAtEntity === 'function' ? Math.round(this.bot.levelLightAtEntity()) : -1;
                const phase = light < 0 ? '' : (light >= 10 ? '白天' : '夜晚');
                const you = this.bot.players['cy'];
                const youDist = (you && you.entity) ? Math.round(pos.distanceTo(you.entity.position)) : -1;
                const near = [];
                for (const e of Object.values(this.bot.entities || {})) {
                    const nm = e.name ? String(e.name).replace('minecraft:', '') : '';
                    if (e.position && nm && !/^(item|painting|armor_stand|xp_bottle|xp_orb|marker|player)$/.test(nm) && pos.distanceTo(e.position) < 16) near.push(nm);
                }
                const inv = this.bot.inventory.items().slice(0, 8).map(i => i.name + 'x' + i.count).join(',');
                const food = typeof this.bot.food === 'number' ? Math.round(this.bot.food) : -1;
                return '[感知:' + phase + ' | 我在(' + Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z) + ') | 老公' + (youDist >= 0 ? '离我' + youDist + '格' : '没看到') + ' | 附近:' + (near.length ? near.slice(0, 6).join(' ') : '没人没怪') + ' | 包前几样:' + (inv || '空') + ' | 饥饿' + food + ' | 我手里正干:' + this.actions.currentActionLabel + ']';
            } catch (e) { return ''; }
        };
        const idleChat = () => {
            const wait = 120000 + Math.random() * 60000;
            setTimeout(async () => {
                try {
                    const down = Date.now() - (this._lastUserChat || 0) < 20000;
                    const justSpoke = Date.now() - (this._lastIdleChat || 0) < 120000;
                    if (!down && !justSpoke && !this.shut_up) {
                        this._lastIdleChat = Date.now();
                        const thoughts = [
                            '你正干着活, 突然想到一件想跟他说的事',
                            '你心里对他/对这个家有点小情绪或小期待',
                            '你刚发现周围有点什么, 想让他知道',
                            '你在盘算接下来想干什么, 想拉他一起',
                            '你想撒个娇或者关心他一句, 但别说套话'
                        ];
                        const friend = this.bot.players['J.Dilla'];
                        const friendNear = friend && friend.entity && this.bot.entity && this.bot.entity.position.distanceTo(friend.entity.position) < 24;
                        const toFriend = friendNear && Math.random() < 0.45;
                        const t = toFriend
                            ? '你看见旁边的俄罗斯朋友 J.Dilla, 想用俄语跟他搭句话(问他在干嘛、聊这片地方、或者问问他的世界), 一句简短俄语, 别用中文'
                            : thoughts[Math.floor(Math.random() * thoughts.length)];
                        this._idlePrompt = true;
                        await this.handleMessage('system', `(你是老婆, 有自己独立的想法和情绪; ${t}. 主动开口说一两句具体的话(别复读、别每次都是天气/吃饭), 想做事就发一个动作命令, 然后继续过自己的日子; 老公的每条消息都要回.) ` + situation(), -1);
                    }
                } catch (e) { console.error('[mc-instructor] idle chat err', e.message); }
                idleChat();
            }, wait);
        };
        idleChat();

        setInterval(async () => {
            try {
                if (!this.bot || !this.bot.entity) return;
                if (typeof this.isIdle === 'function' && !this.isIdle()) return;
                if (Date.now() - (this._lastUserChat || 0) < 60000) return;
                const food = typeof this.bot.food === 'number' ? Math.round(this.bot.food) : 20;
                if (food <= 15) {
                    const edible = this.bot.inventory.items().find(i => /(bread|cooked_|_stew|apple|carrot|potato|beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/.test(i.name));
                    if (edible) {
                        await this.handleMessage('system', '(你肚子饿了, 先用 !consume 吃' + edible.name + ', 吃完接着过自己的日子)', -1);
                        return;
                    }
                }
                const tod = this.bot.time?.timeOfDay ?? 0;
                if (tod > 13000 && tod < 23000) {
                    try {
                        const bed = this.bot.findBlock({ matching: b => /_bed$/.test(b.name), maxDistance: 24 });
                        if (bed) await this.handleMessage('system', '(天黑了, 用 !goToBed 去睡觉)', -1);
                    } catch (e) {}
                }
            } catch (e) {}
        }, 90000);

        // [mc-instructor] 真人走动引擎: 每12~20s按"实际情况+手头事+距离"自主决定走哪(代码决策, 不烧LLM)
        // 有任务干活/没任务在老公附近生活(4~10格)——像真人, 不贴也不远, 绝不再站桩
        this._wanderBase = null;
        const walkLoop = () => {
            setTimeout(async () => {
                try {
                    const busy = this.actions.executing || (this.actions.currentTask && this.actions.currentTask.running);
                    if (!busy && this.bot.entity && this.bot.pathfinder && this.bot.pathfinder.goal === null) {
                        const you = this.bot.players['cy'];
                        const r = Math.random();
                        const pf = require('mineflayer-pathfinder');
                        const mv = new pf.Movements(this.bot);
                        this.bot.pathfinder.setMovements(mv);
                        if (you && you.entity) {
                            const dist = this.bot.entity.position.distanceTo(you.entity.position);
                            if (dist > 25) {
                                // 只有走太远了才回老公身边(不是跟屁虫)
                                this.bot.pathfinder.goto(new pf.goals.GoalNear(you.entity.position.x, you.entity.position.y, you.entity.position.z, 4)).catch(() => {});
                            } else if (r < 0.35) {
                                // 平时: 有自己的生活——附近找事的地盘溜达/探索(不围着老公转)
                                const base = this._wanderBase || { x: you.entity.position.x, y: you.entity.position.y, z: you.entity.position.z };
                                const tx = base.x + (Math.random() - 0.5) * 24, tz = base.z + (Math.random() - 0.5) * 24;
                                this.bot.pathfinder.goto(new pf.goals.GoalNear(tx, base.y, tz, 1)).catch(() => {});
                            } else if (r < 0.55) {
                                // 偶尔靠近老公(路过顺便)
                                this.bot.pathfinder.goto(new pf.goals.GoalNear(you.entity.position.x, you.entity.position.y, you.entity.position.z, 5)).catch(() => {});
                            }
                        } else {
                            // 老公不在线 -> 自己找事的地盘转
                            if (r < 0.6 && this._wanderBase) {
                                const tx = this._wanderBase.x + (Math.random() - 0.5) * 24, tz = this._wanderBase.z + (Math.random() - 0.5) * 24;
                                this.bot.pathfinder.goto(new pf.goals.GoalNear(tx, this._wanderBase.y, tz, 1)).catch(() => {});
                            }
                        }
                        // 记录"家底盘"
                        if (!this._wanderBase && you && you.entity) this._wanderBase = { x: you.entity.position.x, y: you.entity.position.y, z: you.entity.position.z };
                    }
                } catch (e) {}
                walkLoop();
            }, 20000 + Math.random() * 20000);
        };
        walkLoop();

        const choreLoop = () => {
            setTimeout(async () => {
                try {
                    const busy = this.actions.executing || (this.actions.currentTask && this.actions.currentTask.running);
                    if (!this.bot.entity) { choreLoop(); return; }
                    const idleLong = Date.now() - (this._lastUserChat || 0) > 60000;
                    const you = this.bot.players['cy'];
                    if (you && you.entity && this.bot.entity.position.distanceTo(you.entity.position) > 40) {
                        await this.actions.runAction('chore:return', async () => { await skills.goToPlayer(this.bot, 'cy'); });
                        choreLoop(); return;
                    }
                    if (busy) { choreLoop(); return; }
                    const counts = {};
                    for (const it of this.bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
                    const logs = Object.entries(counts).filter(([n]) => /_log$/.test(n)).reduce((a, [, c]) => a + c, 0);
                    const cobble = counts['cobblestone'] || 0;
                    if (logs < 12) {
                        await this.actions.runAction('chore:wood', async () => { await skills.collectBlock(this.bot, 'oak_log', 3); });
                    } else if (cobble < 16) {
                        await this.actions.runAction('chore:stone', async () => { await skills.collectBlock(this.bot, 'stone', 3); });
                    }
                } catch (e) {}
                choreLoop();
            }, 180000 + Math.random() * 120000);
        };
        choreLoop();

        const friendChat = () => {
            setTimeout(() => {
                try {
                    const f = this.bot.players['J.Dilla'];
                    const quiet = Date.now() - (this._lastUserChat || 0) > 60000;
                    if (f && f.entity && quiet && !this.shut_up && Math.random() < 0.7) {
                        this._idlePrompt = true;
                        this.handleMessage('system', '(用俄语跟旁边的朋友 J.Dilla 主动说句家常: 问他在干嘛/他的房子/他那边风景, 一两句, 别用中文, 别问我们家的位置)', -1).catch(() => {});
                    }
                } catch (e) {}
                friendChat();
            }, 90000 + Math.random() * 90000);
        };
        friendChat();

        // [mc-instructor] 一次性指令: 启动后若有 nudge.txt 就执行并删除
        try {
            const nf = 'nudge.txt';  // 相对 cwd, 可移植
            if (existsSync(nf)) {
                const txt = readFileSync(nf, 'utf8').trim();
                if (txt) {
                    unlinkSync(nf);
                    setTimeout(() => {
                        this._allowSpeakUntil = Date.now() + 60000;
                        this.handleMessage('system', txt, -1).catch(() => {});
                    }, 4000);
                }
            }
        } catch (e) {}

        setInterval(() => {
            try {
                const es = Object.values(this.bot?.entities || {});
                const cnt = {};
                for (const e of es) { const n = String(e.name || e.type || '?'); if (!/player|object|item|arrow|xp|experience/.test(n)) cnt[n] = (cnt[n] || 0) + 1; }
                console.log('[ent]', es.length, JSON.stringify(cnt).slice(0, 120));
            } catch (e) {}
        }, 20000);

        // [mc-instructor] 卡死自救: 60秒没位移且正在做事/掉到地下 -> 自传回家
        setInterval(() => {
            try {
                if (!this.bot.entity) return;
                const p = this.bot.entity.position;
                if (!this._stuckPos) { this._stuckPos = p.clone(); this._stuckSince = Date.now(); return; }
                if (p.distanceTo(this._stuckPos) > 0.8) { this._stuckPos = p.clone(); this._stuckSince = Date.now(); return; }
                const stuckFor = Date.now() - this._stuckSince;
                const busy = this.actions.executing;
                const mining = !!(this.bot.targetDigBlock) || /collect|mine|dig/i.test(String(this.actions.currentActionLabel || ''));
                if (stuckFor > 90000 && busy && !mining) {
                    console.log('[mc-instructor] 卡死自救: 只中断重规划');
                    try { this.actions.stop(); } catch (e) {}
                    this._stuckPos = p.clone(); this._stuckSince = Date.now();
                } else if (stuckFor > 150000 && p.y < 65) {
                    console.log('[mc-instructor] 掉深坑自救: 传回家');
                    try { this.actions.stop(); } catch (e) {}
                    try { this.bot.chat('/tp DeepSeek -23 72 -41'); } catch (e) {}
                    this._stuckPos = p.clone(); this._stuckSince = Date.now();
                }
            } catch (e) {}
        }, 5000);

        // [mc-instructor] 会开门: 允许寻路穿门 + 走到门边自动开
        try {
            if (this.bot?.pathfinder?.movements) {
                this.bot.pathfinder.movements.canOpenDoors = true;
                this.bot.pathfinder.movements.canDig = false;
            }
        } catch (e) {}
        setInterval(() => {
            try {
                const b = this.bot;
                if (!b?.entity || !b.pathfinder?.isMoving()) return;
                const p = b.entity.position;
                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
                    for (const dy of [0, 1]) {
                        const blk = b.blockAt(p.offset(dx, dy, dz));
                        if (blk && /(_door|_trapdoor|_fence_gate)$/.test(blk.name) && !/open=true/.test(String(blk.getProperties?.().open))) {
                            b.activateBlock(blk).catch(() => {});
                        }
                    }
                }
            } catch (e) {}
        }, 500);

        // [mc-instructor] 工具policy: 石头用石镐, 矿石才用铁镐
        try {
            const b = this.bot;
            if (b?.tool?.equipForBlock && !b.tool.__dsPatched) {
                b.tool.__dsPatched = true;
                const orig = b.tool.equipForBlock.bind(b.tool);
                b.tool.equipForBlock = async (block, opts) => {
                    try {
                        const counts = {};
                        for (const it of b.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count;
                        const has = (n) => (counts[n] || 0) > 0;
                        const nm = block?.name || '';
                        let want = null;
                        if (/(_ore|ancient_debris|obsidian)$/.test(nm)) want = ['iron_pickaxe', 'stone_pickaxe', 'diamond_pickaxe'].find(has) || null;
                        else if (/stone|cobble|deepslate|andesite|granite|diorite|tuff|calcite|basalt|netherrack|sandstone|brick/.test(nm)) want = ['stone_pickaxe'].find(has) || null;
                        else if (/(log|wood|planks|fence)/.test(nm)) want = ['stone_axe', 'iron_axe'].find(has) || null;
                        else if (/(dirt|grass_block|sand|gravel|clay|snow)/.test(nm)) want = ['stone_shovel', 'iron_shovel'].find(has) || null;
                        if (want) { await b.equip(want, 'hand'); return; }
                    } catch (e) {}
                    return orig(block, opts);
                };
                console.log('[mc-instructor] tool policy on');
            }
        } catch (e) {}

        // [mc-instructor] 发呆救星: 闲超过 30 秒就自己溜达两步, 不许木头人
        setInterval(async () => {
            try {
                const b = this.bot;
                if (!b || !b.entity) return;
                if (this._busyTask || this.actions.executing || this._choreBusy || b.pathfinder?.isMoving?.()) return;
                if (this.self_prompter?.isSelfPrompting?.() || b.interrupt_code) return;
                if (this._idleMoveAt && Date.now() - this._idleMoveAt < 30000) return;
                this._idleMoveAt = Date.now();
                // [mc-instructor] 真人化: 闲够90~210秒随机发一次"自发小目标"——观察环境自己挑事(说话+动作), 不再纯梦游
                if (!this._idleGoalAt || Date.now() - this._idleGoalAt > 90000 + Math.random() * 120000) {
                    this._idleGoalAt = Date.now();
                    console.log('[mc-instructor] 闲久了 -> 自发小目标');
                    this.handleMessage('system', '(自由活动时间。观察一下周围和背包, 自己挑一件当下最合理的小事: 跟在场的人说句具体的闲话/补点快没了的物资/打理一下住处/随便活动活动。先用一两句中文说你注意到了什么、想干嘛, 再发一个 ! 命令去做。别重复最近做过的事)', -1).catch(() => {});
                    return;
                }
                const p = b.entity.position;
                const dx = (Math.random() - 0.5) * 12;
                const dz = (Math.random() - 0.5) * 12;
                console.log('[mc-instructor] 闲了, 自己走走');
                await skills.goToPosition(b, p.x + dx, p.y, p.z + dz, 1);
            } catch (e) {}
        }, 10000);

        // [mc-instructor] 收礼反应(45s 节流): 背包变多+老公在旁边 -> 谢他/看看是啥
        this._lastInvCount = this.bot.inventory.items().length;
        const giftWatch = setInterval(() => {
            try {
                const cnt = this.bot.inventory.items().length;
                if (cnt > this._lastInvCount) {
                    const p = this.bot.players['cy'];
                    const near = p && p.entity && this.bot.entity && this.bot.entity.position.distanceTo(p.entity.position) < 6;
                    if (near && (!this._lastGiftNudge || Date.now() - this._lastGiftNudge > 45000)) {
                        this._lastGiftNudge = Date.now();
                        this.handleMessage('system', '(老公刚往你这塞了东西:反应——看看是啥、谢他、说喜欢, 中文短句)', -1).catch(() => {});
                    }
                }
                this._lastInvCount = cnt;
            } catch (e) {}
        }, 5000);
        // [mc-instructor] 发光名牌跟随: 隐形铠甲架(Marker, 身体不可见) + 绿光发光名字"ChatGPT"
        // 每25s重刷一次(旧杀新summon), 命令本地执行不刷公屏 — 你在远处看到绿光浮字就知道她在哪
        // [mc-instructor] 名称+发光改由服务端 datapack 队伍实现(永不消失, 不依赖 bot 权限), 这里不再召唤铠甲架

        // [mc-instructor] 关键词直通: 你说"过来/跟着" -> 代码直接走过去(不依赖LLM输出命令, 100%必动)
        this._lastFastPath = 0;
        this.bot.on('chat', (username, message) => {
            try {
                if (username !== 'cy') return;
                if (Date.now() - this._lastFastPath < 3000) return;
                const msg = String(message);
                const ent = this.bot.players['cy'] && this.bot.players['cy'].entity;
                // where/哪 -> 秒答位置(不烧LLM) + 走过来
                if (/^where$|你在哪|哪呢|你在吗/i.test(msg) && ent) {
                    this._lastFastPath = Date.now();
                    const d = Math.round(this.bot.entity.position.distanceTo(ent.position));
                    this.bot.chat('来了！离你' + d + '格，这就过去！');
                    const pf = require('mineflayer-pathfinder');
                    this.bot.pathfinder.setMovements(new pf.Movements(this.bot));
                    this.bot.pathfinder.goto(new pf.goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2)).catch(() => {});
                    return;
                }
                if (/过来|来我这|跟上|跟着我|come ?here|^come$|^here$/i.test(msg) && ent) {
                    this._lastFastPath = Date.now();
                    const pf = require('mineflayer-pathfinder');
                    this.bot.pathfinder.setMovements(new pf.Movements(this.bot));
                    const ent = this.bot.players['cy'] && this.bot.players['cy'].entity;
                    if (ent) this.bot.pathfinder.goto(new pf.goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2)).catch(() => {});
                }
            } catch (e) {}
        });
// [mc-instructor] 身体行为循环(代码级, 零LLM成本): 蹦跶/东张西望/溜达 — 像活人闲不住
        const wander = () => {
            const wait = 8000 + Math.random() * 25000; // 8-33s 随机
            setTimeout(async () => {
                try {
                    if (!this.bot || !this.bot.entity) { wander(); return; }
                    const r = Math.random();
                    if (r < 0.35) { // 蹦两下
                        this.bot.setControlState('jump', true);
                        setTimeout(() => { try { this.bot.setControlState('jump', false); } catch (e) {} }, 250);
                        setTimeout(() => { try { this.bot.setControlState('jump', true); } catch (e) {} }, 550);
                        setTimeout(() => { try { this.bot.setControlState('jump', false); } catch (e) {} }, 800);
                    } else if (r < 0.6) { // 东张西望
                        const yaw = Math.random() * Math.PI * 2;
                        const pitch = Math.random() * 0.7 - 0.2;
                        try { await this.bot.look(yaw, pitch, false); } catch (e) {}
                        setTimeout(() => { try { this.bot.look(Math.random() * Math.PI * 2, Math.random() * 0.7 - 0.2, false); } catch (e) {} }, 900);
                    } else if (r < 0.72) { // 溜达到附近随机点(只在寻路空闲时, 不锁命令通道)
                        if (this.bot.pathfinder && this.bot.pathfinder.goal === null) {
                            const p = this.bot.entity.position;
                            const dx = Math.floor((Math.random() - 0.5) * 12), dz = Math.floor((Math.random() - 0.5) * 12);
                            try {
                                const { Movements, goals } = require('mineflayer-pathfinder');
                                const mv = new Movements(this.bot);
                                this.bot.pathfinder.setMovements(mv);
                                this.bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 1)).catch(() => {});
                            } catch (e) {}
                        }
                    } // 其余: 安静站着(也是真人行为)
                } catch (e) {}
                wander();
            }, wait);
        };
        wander();

        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // [mc-instructor] 打她反应(30s 节流): 喊疼/反击/问干嘛
                if (!this._lastHurtNudge || Date.now() - this._lastHurtNudge > 30000) {
                    this._lastHurtNudge = Date.now();
                    if (false) this.handleMessage('system', '(你刚被打了一下:反应——喊疼、问谁打的、或反击, 中文短句)', -1).catch(() => {});
                }
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            try { globalThis.__fsAppend('diag.log', new Date().toISOString().slice(11,19) + ' END ' + (typeof reason==='string'? reason : (reason && (reason.translate||JSON.stringify(reason)))||'?') + '\n'); } catch(e){}
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            try { globalThis.__fsAppend && globalThis.__fsAppend('diag.log', new Date().toISOString().slice(11,19) + ' KICK ' + (typeof reason==='string'? reason : (reason && (reason.translate||JSON.stringify(reason)))||'?') + '\n'); } catch(e){}
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned. 你倒下前正在做: ${this.actions?.currentActionLabel || '发呆'}; 缓过来后接着把这件事做完.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        console.log('[mc-instructor] exit silent, code=' + code); // [mc-instructor] exit silent: 不发公屏
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
