import { Vec3 } from 'vec3';

const AIRISH = new Set(['air','cave_air','void_air','short_grass','grass','tall_grass','fern','large_fern','dandelion','poppy','cornflower','snow','torch','wall_torch']);

export function findFlatSpot(bot, pos, radius = 5) {
    const y = Math.floor(pos.y);
    for (let r = 0; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                const bx = Math.floor(pos.x) + dx, bz = Math.floor(pos.z) + dz;
                if (isFlat(bot, bx, y, bz)) return new Vec3(bx, y, bz);
            }
        }
    }
    return null;
}

function isFlat(bot, bx, y, bz) {
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const g = bot.blockAt(new Vec3(bx + ox, y - 1, bz + oz));
        if (!g || g.boundingBox !== 'block') return false;
        for (let oy = 0; oy <= 2; oy++) {
            const a = bot.blockAt(new Vec3(bx + ox, y + oy, bz + oz));
            if (!a) return false;
            if (a.boundingBox === 'block') return false;
        }
    }
    return true;
}

export function pickMaterial(bot) {
    const items = bot.inventory.items();
    const order = [/cobblestone$/, /_planks$/, /^stone$/, /^dirt$/, /_log$/, /_wood$/, /^sandstone$/];
    for (const re of order) {
        for (const it of items) {
            if (re.test(it.name) && it.count >= 20) return it;
        }
    }
    for (const it of items) if (it.count >= 20 && /block$/.test(it.name)) return it;
    return null;
}

export async function buildHut(bot, anchor, material, log = () => {}) {
    const y = anchor.y;
    let placed = 0, failed = 0;
    const targets = [];
    const walls = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dz] of walls) {
        for (let dy = 0; dy <= 1; dy++) {
            if (dx === 0 && dz === 1) continue;
            targets.push(new Vec3(anchor.x + dx, y + dy, anchor.z + dz));
        }
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) targets.push(new Vec3(anchor.x + dx, y + 2, anchor.z + dz));

    for (const t of targets) {
        const cur = bot.blockAt(t);
        if (cur && cur.boundingBox === 'block') continue;
        if (cur && !AIRISH.has(cur.name)) {
            try { await bot.dig(cur, true); } catch (e) {}
        }
        if (bot.inventory.count(material.type, null) <= 0) { failed++; continue; }
        try { await bot.equip(bot.inventory.findInventoryItem(material.type), 'hand'); } catch (e) {}
        const refs = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]];
        let ok = false;
        for (const [ox, oy, oz] of refs) {
            const ref = bot.blockAt(t.offset(ox, oy, oz));
            if (!ref || ref.boundingBox !== 'block') continue;
            try { await bot.placeBlock(ref, new Vec3(-ox, -oy, -oz)); ok = true; break; } catch (e) {}
        }
        if (ok) { placed++; log(`placed ${t.x},${t.y},${t.z}`); } else failed++;
        await new Promise(r => setTimeout(r, 120));
    }
    return { placed, failed, total: targets.length };
}
