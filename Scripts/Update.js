#!/usr/bin/env node
/**
 * Mise à jour de la BDD UniVersus pour TCG Arena.
 *
 *  - Cartes et stats : uvscards.fyi (data/cards.json). Une entrée par carte avec toutes ses impressions
 *    (officielle, alt-art, chrome, promo…) : nom, type, set, numéro, rareté, difficulté, check, blocage, attaque, vie…
 *  - Images : uvsgames.com (API WordPress publique du site officiel). Chaque image est reliée à une impression
 *    uvscards.fyi par le nom de la carte, puis départagée par numéro, set et type d'impression (alt-art, chrome).
 *    Si uvsgames.com n'a pas l'image, on prend celle de uvscards.fyi (CONFIG.useFyiImages = false pour ne garder
 *    que les impressions avec une image uvsgames.com).
 *  - Cartes recto-verso (Attack on Titan…) : le verso va dans face.back.
 *  - Les cartes de type Special ne sont pas dans la liste ; les Tokens ont isToken: true.
 *
 *  Format TCG Arena, comme les autres jeux : id, face.front (+ face.back), name, type, cost (= difficulté), rarity, stats, set
 *    - id    = code du set + numéro : "TK802-001", alt-art "TK802-021-ALT", chrome "-CHR", promo "-P", reboot "-RB".
 *              Si deux cartes ont le même numéro dans un set (decks des Challenger Series), "-2", "-3"… (ordre alphabétique)
 *    - name  = nom de la carte : toutes les impressions d'une carte ont le même nom → skins dans TCG Arena
 *  - Une carte disparue est conservée telle quelle (aucune carte perdue pour les decks existants)
 *  - Rapport détaillé dans Scripts/update-report.md
 *
 * Emplacement : Scripts/Update.js (les chemins partent de la racine du repo)
 * Usage       : node Scripts/Update.js        (FORCE=1 pour écrire même si beaucoup de cartes manquent)
 * Dépendances : aucune (Node 18+)
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    fyiUrl: process.env.FYI_URL || 'https://uvscards.fyi/data/cards.json',
    fyiImageBase: trimSlash(process.env.FYI_IMAGE_BASE || 'https://uvscards.fyi'),
    useFyiImages: process.env.FYI_IMAGES !== '0',   // image uvscards.fyi quand uvsgames.com n'en a pas (FYI_IMAGES=0 pour désactiver)
    fyiMaxAgeDays: 30,                       // avertissement si uvscards.fyi n'a pas été mis à jour depuis
    uvsApiBase: trimSlash(process.env.UVS_API_BASE || 'https://uvsgames.com/wp-json/wp/v2'),
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    cardsFile: 'UniversusCards.json',        // fichier du jeu, à la racine du repo
    reportPath: path.join(__dirname, 'update-report.md'),

    perPage: 100,                            // maximum de l'API WordPress
    delayMs: 300,                            // pause entre deux requêtes
    timeoutMs: 120_000,
    retries: 3,
    minRatioVsPrevious: 0.8,                 // refuse d'écrire si on perd >20% des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-UniVersus-updater/2.0 (+https://tcg-arena.fr)',
};

const TAXONOMIES = ['card-series', 'card-type'];
const EXCLUDED_TYPES = /\bspecials?\b/i;     // types retirés de la liste (uvscards.fyi ou uvsgames.com)
const TOKEN_TYPES = /\btokens?\b/i;
const KIND_ORDER = ['official', 'alt-art', 'chrome', 'promo', 'reboot'];
const LEGACY_ID = /^UVS-/;                    // ids des anciennes versions du script ("UVS-…"), remplacés
const KIND_SUFFIX = { 'alt-art': '-ALT', chrome: '-CHR', promo: '-P', reboot: '-RB' };

/**
 * Code de chaque set (nom uvscards.fyi → code utilisé dans les ids). Un set absent d'ici prend un code automatique
 * (initiales) et est signalé dans le rapport : ajoute-le ici. Ne change pas un code existant : les ids des cartes changeraient.
 */
const SET_CODES = {
    'Fairy Tail: All Fired Up!': 'FT01',
    'Street Fighter 6 Challenger Series': 'SF6CS',
    'Street Fighter 6 Challenger Series 2nd Release': 'SF6CS2',
    'Tekken 8': 'TK802',
    'Tekken 8 Clash Decks': 'TK801',
    'My Hero Academia: Final Battle Challenger Series - Heroes': 'MHA09-CS1',
    'My Hero Academia: Final Battle Challenger Series - Villains': 'MHA09-CS2',
    'My Hero Academia: Dark Hero Arc Challenger Series': 'MHA08',
    'MHA07 - Girl Power': 'MHA07',
    'MHA Class Reunion': 'MHA-CR',
    'UVS06 Jet Burn': 'MHA06',
    'UVS06 Plus Ultra': 'MHA06-PU',
    'UVS06 Ochaco Clash Deck': 'MHA06-CD1',
    'UVS06 Toga Clash Deck': 'MHA06-CD2',
    'UVS05 Undaunted Raid': 'MHA05',
    'UVS05 Undaunted Raid Pre-Release': 'MHA05-PR',
    'UVS05 Clash Deck': 'MHA05-CD',
    'UVS05 Plus Ultra': 'MHA05-PU',
    'UVS05 Provisional': 'MHA05-PV',
    'UVS05 Chrome Rares': 'MHA05-CHR',
    'UVS04 League of Villains': 'MHA04',
    'UVS04 League of Villains Extra Credit Series': 'MHA04-EC',
    'UVS04 Clash Deck': 'MHA04-CD',
    'UVS04 DLC': 'MHA04-DLC',
    'UVS04 Plus Ultra': 'MHA04-PU',
    'UVS04 Provisional': 'MHA04-PV',
    'UVS04 Quirk Pack': 'MHA04-QP',
    'UVS03 Heroes Clash': 'MHA03',
    'UVS03 Endeavor Clash Deck': 'MHA03-CD1',
    'UVS03 Eraser Head Clash Deck': 'MHA03-CD2',
    'UVS03 DLC': 'MHA03-DLC',
    'UVS03 Plus Ultra': 'MHA03-PU',
    'UVS03 Provisional': 'MHA03-PV',
    'UVS03 Quirk Pack': 'MHA03-QP',
    'UVS02 Crimson Rampage': 'MHA02',
    'UVS02 DLC': 'MHA02-DLC',
    'UVS02 Plus Ultra': 'MHA02-PU',
    'UVS02 Provisional': 'MHA02-PV',
    'UVS02 Quirk Pack': 'MHA02-QP',
    'UVS01 My Hero Academia': 'MHA01',
    'UVS01 DLC': 'MHA01-DLC',
    'UVS01 Plus Ultra Pack': 'MHA01-PU',
    'UVS01 Provisional': 'MHA01-PV',
    'UVS01 Quirk Pack': 'MHA01-QP',
    'UVS01 Regional Promos': 'MHA01-RP',
    'Attack on Titan: Battle for Humanity': 'AOT01',
    'Attack on Titan: Origins of Power': 'AOT02',
    'Attack on Titan: Apocalypse': 'AOT03',
    'Godzilla: Reign of Kaiju': 'GDZ01',
    'Challenger Series Godzilla': 'GDZCS',
    'GM001 Godzilla Promo': 'GM001',
    'Critical Role: Heroes of Exandria': 'CR01',
    'Critical Role Challenger Series: Vox Machina': 'CRCS-VM',
    'Critical Role Challenger Series: Mighty Nein': 'CRCS-MN',
    'Star Trek: Lower Decks Challenger Series': 'STLD',
    'Solo Leveling Challenger Series': 'SLCS',
    'King of Fighters': 'KOF',
    'Guilty Gear -Strive-': 'GGS01',
    'Teenage Mutant Ninja Turtles': 'TMNT01',
    'Teenage Mutant Ninja Turtles Starter Deck': 'TMNT01-SD',
    'Yu Yu Hakusho Dark Tournament': 'YYH01',
    'Yu Yu Hakusho Dark Tournament - Retro Reprint': 'YYH01-RR',
    'CB02 Cowboy Bebop Challenger': 'CB02',
    'TS01 Trigun Stampede': 'TS01',
    'Rebel Frontier': 'RF01',
    'Borderlands 4 Experience Bundle': 'BL4',
    'Borderlands 4': 'BL4-ALT',
    'PROMO26': 'PROMO26',
    'PROMO25': 'PROMO25',
    'PROMO24': 'PROMO24',
    'PROMO 2023': 'PROMO23',
    'PROMO 2022': 'PROMO22',
    'PROMO 2021': 'PROMO21',
    '2022 Convention Promos': 'CONV22',
};

/** Morceaux de nom de fichier qui ne font pas partie du nom de la carte : rareté ("UC", "CHUR", "C-ALT"…), "ALT", "CR"…
 *  (sensible à la casse : "Chu" est un nom, "CHU" une rareté) */
const FILE_MARKERS = /^(?:(?:CH)?(?:C|UC|U|R|SR|UR|XR|SE|SEC)?(?:ALT)?|CR|RR|PR|P|AA|SP|VICTORY|PROMO|FOIL|HOLO|CHROME|TOKEN|[Cc]ard[Ss]hots?|Auto)$/;
/** Mentions de version en fin de titre uvsgames.com : "(Alternate Art)", "(Autograph Version)"… */
const PRINTING_TAG = /\s*\((?:[^()]*\b(?:alternate|alt\.?\s?art|serial|numbered|chrome|foil|promo|pre-?release|textured|full\s?art|showcase|judge|champion|winner|participa\w*|regionals?|nationals?|worlds?|season|kickstarter|topper|extended|reprint|stamped|platinum|holo|autograph\w*|signature|signed|version|card\s?shots?)\b[^()]*)\)\s*$/i;

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = [];
function report(level, category, id, message) { issues.push({ level, category, id: String(id), message: message || '' }); }

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = s => fold(s).replace(/[^a-z0-9]/g, '');
const num = v => (v === undefined || v === null || clean(v) === '' || isNaN(Number(v)) ? undefined : Number(v));
const fileOf = url => { try { return decodeURIComponent(String(url || '').split('/').pop() || ''); } catch { return String(url || '').split('/').pop(); } };
const capitalize = s => clean(s).replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const majority = map => (map && map.size ? [...map.entries()].sort((a, b) => b[1] - a[1])[0][0] : undefined);
const vote = (map, key, value) => {
    if (!key || !value) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(value, (map.get(key).get(value) || 0) + 1);
};
const groupPush = (map, key, value) => { map.set(key, [...(map.get(key) || []), value]); };

function decodeEntities(s) {
    return String(s ?? '')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
        .replace(/&hellip;/g, '…').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&amp;/g, '&');
}

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.relative(CONFIG.repoRoot, file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', content);
    await fsp.rename(file + '.tmp', file);
}

/** GET JSON avec retries (réseau, 429, 5xx) → { data, totalPages } | { end } (page WordPress au-delà de la fin) | { error } */
async function getJson(url) {
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
            const text = await res.text();
            if (res.ok) {
                try {
                    return { data: JSON.parse(text), totalPages: Number(res.headers.get('x-wp-totalpages')) || null };
                } catch {
                    return { error: `réponse non JSON (${text.slice(0, 120).replace(/\s+/g, ' ')})` };
                }
            }
            if (res.status === 400 && /rest_post_invalid_page_number|invalid_page/i.test(text)) return { end: true };
            lastError = `HTTP ${res.status}`;
            if (res.status !== 429 && res.status < 500) return { error: `${lastError} (${text.slice(0, 150).replace(/\s+/g, ' ')})` };
            if (res.status === 429) await sleep(15_000);
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(3000 * 2 ** (attempt - 1));
    }
    return { error: lastError };
}

/** Toutes les pages d'une liste WordPress */
async function fetchAllPages(route, params = '') {
    const items = [];
    for (let page = 1; ; page++) {
        const url = `${CONFIG.uvsApiBase}${route}?per_page=${CONFIG.perPage}&page=${page}${params ? '&' + params : ''}`;
        const res = await getJson(url);
        if (res.end) break;
        if (res.error) throw new Error(`${route} page ${page} : ${res.error}`);
        if (!Array.isArray(res.data)) throw new Error(`${route} page ${page} : la réponse n'est pas une liste`);
        items.push(...res.data);
        process.stdout.write(`\r   ${route} : ${items.length}${res.totalPages ? ` (page ${page}/${res.totalPages})` : ''}   `);
        if (res.data.length < CONFIG.perPage || (res.totalPages && page >= res.totalPages)) break;
        await sleep(CONFIG.delayMs);
    }
    process.stdout.write('\n');
    return items;
}

// ─────────────────────────────── Noms et codes ───────────────────────────────

/**
 * Code d'un nom de fichier (ou d'un titre qui en est un) :
 *   "TK802-001-CR-HeihachiMishima.png"   → set "TK802",  n° 1,   nom ["HeihachiMishima"]
 *   "YYH-DT-142-KeikosSupport-UC.png"     → set "YYH-DT", n° 142
 *   "AOT3-001a-CH-AnnieLeonhartAwakened"  → set "AOT3",   n° 1, face "a"
 *   "MHACCG-S7-181-AcidScreen-ALT-SR.png" → set "MHACCG-S7", n° 181
 *   "YYH-DT-R038-SpiritShotgun-RR.png"    → set "YYH-DT", n° 38
 *   "103_Tenya_Iida.png"                  → pas de set, n° 103
 */
function fileCode(str) {
    const base = fileOf(str).replace(/\.(?:png|jpe?g|webp|gif|avif)$/i, '');
    const parts = base.split(/[-_ ]+/).filter(Boolean);
    if (parts.length < 2) return null;
    // numéro : d'abord un morceau tout en chiffres ("181", "104a"), sinon une lettre + chiffres ("R038")
    let i = parts.findIndex((p, j) => j < 4 && /^\d{1,4}[A-Za-z]?$/.test(p));
    if (i < 0) i = parts.findIndex((p, j) => j > 0 && j < 4 && /^[A-Za-z]\d{1,4}[A-Za-z]?$/.test(p));
    if (i < 0 || (i > 0 && !/^[A-Za-z]/.test(parts[0]))) return null;
    const m = parts[i].match(/^([A-Za-z]?)(\d{1,4})([A-Za-z]?)$/);
    const set = parts.slice(0, i).join('-').toUpperCase();
    return {
        set, first: (parts[0] && i > 0 ? parts[0] : '').toUpperCase(), num: Number(m[2]), face: m[3].toLowerCase(), digits: m[2].length,
        label: `${set ? set + '-' : '#'}${m[1].toUpperCase()}${Number(m[2])}${m[3].toLowerCase()}`,
        nameParts: parts.slice(i + 1).filter(p => !FILE_MARKERS.test(p)),
        markers: parts.slice(i + 1).filter(p => FILE_MARKERS.test(p)).map(p => p.toUpperCase()),
    };
}

/** Titre sans mention de version : "Heihachi Mishima (Autograph Version)" → "Heihachi Mishima" */
function stripTag(raw) {
    let s = clean(raw);
    for (let i = 0; i < 3 && PRINTING_TAG.test(s); i++) s = s.replace(PRINTING_TAG, '').trim();
    return s || clean(raw);
}

/** Distance d'édition bornée (s'arrête dès que max est dépassé) */
function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < best) best = cur[j];
        }
        if (best > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

/** Noms normalisés proches : l'un commence par l'autre, faute de frappe, ou long début commun */
function closeNames(a, b) {
    if (!a || !b) return false;
    if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    const max = Math.max(1, Math.floor(Math.min(a.length, b.length) / 5));
    if (levenshtein(a, b, max) <= max) return true;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i >= Math.min(10, Math.floor(Math.min(a.length, b.length) * 0.6));
}

/** Ressemblance de deux noms de set (0 à 1) : "MHA06 Jet Burn" ≈ "UVS06 Jet Burn", "Godzilla Challenger Series" ≈ "Challenger Series Godzilla" */
const STOP_WORDS = new Set(['the', 'of', 'for', 'and', 'a', 'an']);
function setTokens(s) {
    return new Set(fold(s).split(/[^a-z0-9]+/).filter(w => w && !STOP_WORDS.has(w))
        .map(w => w.replace(/^[a-z]{2,5}0*(\d{1,3})$/, '#$1')));
}
function setSimilarity(a, b) {
    const ta = setTokens(a), tb = setTokens(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
}

/** Clés de nom d'une carte uvscards.fyi : nom complet (3), avant la virgule (2), recto d'une recto-verso (3), libellé promo (2) */
function fyiKeys(name, label) {
    const keys = new Map();
    const add = (s, q) => { const k = norm(s); if (k && (keys.get(k) || 0) < q) keys.set(k, q); };
    add(name, 3);
    const front = name.includes('//') ? name.split('//')[0].trim() : name;
    add(front, 3);
    if (front.includes(',')) add(front.split(',')[0], 2);
    add(front.replace(/(\s*\((?:[IVX]+|True Form)\))+\s*$/, ''), 2); // "Tenya Iida (I)", "All Might (True Form) (IV)" → sans la version
    if (label && !/^reboot$/i.test(label)) {
        add(label, 2);
        add(label.replace(/\s*\([^()]*\)\s*$/, ''), 2);
    }
    return keys;
}

// ─────────────────────────────── Format UniversusCards.json ───────────────────────────────

/** attrs uvscards.fyi [[nom, [valeurs], [icônes]], …] → { nom: [valeurs] } */
function attrsOf(list) {
    const out = {};
    for (const a of Array.isArray(list) ? list : []) if (Array.isArray(a) && a[0]) out[a[0]] = (Array.isArray(a[1]) ? a[1] : []).map(clean).filter(Boolean);
    return out;
}
const one = (a, k) => a[k]?.[0];
const numOrText = v => num(v) ?? (clean(v) || undefined);

function buildCardEntry(f, image, back) {
    const a = f.attrs;
    const difficulty = num(one(a, 'Difficulty'));
    const type = f.type;
    const name = f.card.name;
    const front = f.isDfc ? clean(name.split('//')[0]) : name;
    const keywords = [...new Set([...(a['Keyword Traits'] || []), ...(a['Character Trait Keywords'] || []), ...(a['Keyword Abilities'] || [])])];
    const entry = {
        id: f.id,
        face: {
            front: { name: front, type, cost: difficulty ?? 0, image: image.url, isHorizontal: image.isHorizontal },
            back: back ? { name: clean(name.split('//')[1] || name), type, cost: difficulty ?? 0, image: back.url, isHorizontal: back.isHorizontal } : undefined,
        },
        name,
        type,
        cost: difficulty ?? 0,
        rarity: clean(f.p.rarity) || undefined,
        symbols: (a['Card Resource Symbols'] || []).map(s => (/^inf/i.test(s) ? 'Infinity' : capitalize(s))),
        keywords: keywords.length ? keywords : undefined,
        difficulty,
        check: num(one(a, 'Check Value')),
        blockZone: one(a, 'Block Zone'),
        blockModifier: numOrText(one(a, 'Block Mod')),
        speed: numOrText(one(a, 'Speed')),
        damage: numOrText(one(a, 'Damage')),
        attackZone: one(a, 'Attack Zone'),
        handSize: num(one(a, 'Hand Size')),
        vitality: numOrText(one(a, 'Health')),
        number: num(f.p.no),
        set: f.set,
    };
    if (f.isToken) entry.isToken = true;
    return JSON.parse(JSON.stringify(entry)); // retire les champs undefined
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const lines = [];
    lines.push(`# Mise à jour des cartes UniVersus — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    lines.push(`| uvscards.fyi (généré le ${summary.fyiGenerated || '?'}) | ${summary.fyiCards} cartes, ${summary.fyiPrintings} impressions |`);
    lines.push(`| Images sur uvsgames.com | ${summary.uvsCount} (dont ${summary.uvsDuplicates} en double) |`);
    lines.push(`| Impressions avec image uvsgames.com (par nom / par numéro) | ${summary.byName + summary.byNumber} (${summary.byName} / ${summary.byNumber}) |`);
    if (CONFIG.useFyiImages) lines.push(`| Impressions avec image uvscards.fyi | ${summary.fyiImages} |`);
    lines.push(`| Impressions sans image (pas dans la liste) | ${summary.dropped} |`);
    lines.push(`| Versos trouvés (cartes recto-verso) | ${summary.backs} / ${summary.dfc} |`);
    lines.push(`| Images uvsgames.com non utilisées | ${summary.unusedUvs} |`);
    lines.push(`| Cartes de type Special retirées | ${summary.special} |`);
    lines.push(`| Cartes dans ${CONFIG.cardsFile} | ${summary.cardCount} (avant : ${summary.previousCount}${summary.legacy ? `, + ${summary.legacy} de l'ancien format supprimées` : ''}) |`);
    lines.push(`| Noms différents (cartes jouables) | ${summary.nameCount} |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Cartes disparues (conservées) | ${summary.kept.length} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    if (summary.bySet.length) {
        lines.push('## Sets (du plus récent au plus ancien)', '', `| Set | Impressions | Image uvsgames.com |${CONFIG.useFyiImages ? ' Image uvscards.fyi |' : ''} Sans image |`,
            `|---|---|---|${CONFIG.useFyiImages ? '---|' : ''}---|`);
        summary.bySet.forEach(s => lines.push(`| ${s.name} | ${s.total} | ${s.uvs} |${CONFIG.useFyiImages ? ` ${s.fyi} |` : ''} ${s.none} |`));
        lines.push('');
    }
    if (summary.types.length) {
        lines.push('## Types', '', '| Type | Cartes |', '|---|---|');
        summary.types.forEach(([t, n]) => lines.push(`| ${t} | ${n} |`));
        lines.push('');
    }

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) groupPush(byCat, i.category, i);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.slice(0, 300).forEach(i => lines.push(`- \`${i.id}\`${i.message ? ' — ' + i.message : ''}`));
            if (items.length > 300) lines.push(`- … et ${items.length - 300} autre(s)`);
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.added.length && summary.previousCount) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        summary.added.forEach(e => lines.push(`- \`${e.id}\` ${e.name} (${e.set})`));
        lines.push('');
    }
    return lines.join('\n');
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir Scripts/update-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => groupPush(byCat, i.category, i));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id}${i.message ? ' : ' + i.message : ''}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Sources ───────────────────────────────

/** Impressions uvscards.fyi, avec les infos de leur carte */
async function loadFyi(summary) {
    console.log(`📥 uvscards.fyi : ${CONFIG.fyiUrl}`);
    const res = await getJson(CONFIG.fyiUrl);
    if (res.error) throw new FatalError(`uvscards.fyi inaccessible : ${res.error}`);
    const cards = res.data?.cards;
    if (!Array.isArray(cards) || !cards.length) throw new FatalError('uvscards.fyi : pas de liste "cards" dans la réponse');
    summary.fyiGenerated = clean(res.data.generated).slice(0, 10);
    const age = (Date.now() - Date.parse(res.data.generated)) / 86_400_000;
    if (age > CONFIG.fyiMaxAgeDays) report('warning', 'uvscards.fyi pas mis à jour récemment', summary.fyiGenerated, `${Math.floor(age)} jours`);

    const printings = [];
    for (const card of cards) {
        const name = clean(card?.name);
        const list = Array.isArray(card?.printings) ? card.printings : [];
        if (!name || !list.length) { report('error', 'Cartes uvscards.fyi illisibles (ignorées)', name || '?', 'pas de nom ou pas d\'impression'); continue; }
        if (/^\w+:\s*(?:true|false|null|\d+),?$/i.test(name)) { report('error', 'Cartes uvscards.fyi illisibles (ignorées)', name, 'nom invalide (erreur dans leurs données)'); continue; }
        // stats de la carte : celles de l'impression officielle (certaines impressions n'en ont pas)
        const ref = [...list].sort((x, y) => (x.kind === 'official' ? 0 : 1) - (y.kind === 'official' ? 0 : 1)).find(p => Array.isArray(p.attrs) && p.attrs.length);
        for (const p of list) {
            if (!p?.id) { report('error', 'Impressions uvscards.fyi sans id (ignorées)', name, p?.set || ''); continue; }
            printings.push({
                idx: printings.length, id: null, fyiId: String(p.id), p, card, name,
                type: capitalize(card.type || 'Unknown'),
                set: clean(p.set) || 'Unknown',
                slug: norm(p.setSlug),
                kind: clean(p.kind).toLowerCase() || 'official',
                no: num(p.no),
                attrs: attrsOf(Array.isArray(p.attrs) && p.attrs.length ? p.attrs : ref?.attrs),
                keys: fyiKeys(name, clean(p.label)),
                isDfc: name.includes('//'),
            });
        }
    }
    summary.fyiCards = cards.length;
    summary.fyiPrintings = printings.length;

    // ids : code du set + numéro (+ type d'impression), "-2", "-3"… si plusieurs cartes ont le même
    const autoCodes = new Map();
    const codeOf = set => {
        if (SET_CODES[set]) return SET_CODES[set];
        if (!autoCodes.has(set)) {
            const auto = set.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => (/\d/.test(w) ? w : w[0])).join('').toUpperCase().slice(0, 10) || 'UNK';
            autoCodes.set(set, auto);
            report('warning', 'Sets sans code dans SET_CODES (code automatique, ajoute-le dans le script)', auto, set);
        }
        return autoCodes.get(set);
    };
    const byBase = new Map();
    for (const f of printings) {
        const code = codeOf(f.set);
        const kind = /chrome/i.test(f.p.rarity) || f.p.rc === 'cr' ? 'chrome' : f.kind; // "Chrome Rare" rangée en "official"
        const suffix = /^(?:PROMO|CONV)/.test(code) && kind === 'promo' ? '' : (KIND_SUFFIX[kind] || '');
        groupPush(byBase, `${code}-${String(f.no ?? 0).padStart(3, '0')}${suffix}`, f);
    }
    for (const [base, list] of byBase) {
        list.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.fyiId.localeCompare(b.fyiId));
        list.forEach((f, i) => { f.id = i ? `${base}-${i + 1}` : base; });
    }
    return printings;
}

/** Images uvsgames.com (une par fichier image), avec leurs clés de nom et leur code */
async function loadUvs(summary) {
    console.log(`📥 uvsgames.com : ${CONFIG.uvsApiBase}`);
    const terms = {};
    for (const tax of TAXONOMIES) {
        terms[tax] = new Map();
        try {
            for (const t of await fetchAllPages(`/${tax}`, '_fields=id,name')) terms[tax].set(t.id, clean(decodeEntities(t.name)));
        } catch (e) {
            report('warning', 'Catégories uvsgames.com inaccessibles (moins de précision pour relier les images)', tax, e.message);
        }
        await sleep(CONFIG.delayMs);
    }
    const names = (card, tax) => (Array.isArray(card[tax]) ? card[tax] : []).map(id => terms[tax].get(id)).filter(Boolean);

    let cards;
    try {
        cards = await fetchAllPages('/card', 'orderby=id&order=asc&_embed=wp:featuredmedia' +
            '&_fields=id,title,featured_media,' + TAXONOMIES.join(',') + ',_links,_embedded');
    } catch (e) {
        throw new FatalError(`Liste des cartes uvsgames.com inaccessible : ${e.message}`);
    }
    if (!cards.length) throw new FatalError('uvsgames.com n\'a renvoyé aucune carte');
    cards.sort((a, b) => a.id - b.id);

    // images non incluses dans la réponse : récupérées par lots de 100
    const mediaOf = new Map();
    for (const c of cards) {
        const m = c._embedded?.['wp:featuredmedia']?.find(x => x && x.source_url);
        if (m) mediaOf.set(c.id, m);
    }
    const missing = [...new Set(cards.filter(c => !mediaOf.has(c.id) && c.featured_media).map(c => c.featured_media))];
    if (missing.length) {
        const byMediaId = new Map();
        for (let i = 0; i < missing.length; i += CONFIG.perPage) {
            const ids = missing.slice(i, i + CONFIG.perPage);
            const res = await getJson(`${CONFIG.uvsApiBase}/media?include=${ids.join(',')}&per_page=${CONFIG.perPage}&_fields=id,source_url,media_details`);
            if (Array.isArray(res.data)) for (const m of res.data) byMediaId.set(m.id, m);
            else report('warning', 'Images uvsgames.com inaccessibles', `media ${ids[0]}…`, res.error || 'réponse inattendue');
            await sleep(CONFIG.delayMs);
        }
        for (const c of cards) if (!mediaOf.has(c.id) && byMediaId.has(c.featured_media)) mediaOf.set(c.id, byMediaId.get(c.featured_media));
    }

    const images = [];
    const seenFiles = new Set();
    for (const c of cards) {
        const media = mediaOf.get(c.id);
        if (!media?.source_url) continue;
        const file = fileOf(media.source_url);
        if (seenFiles.has(file.toLowerCase())) { summary.uvsDuplicates++; continue; } // même image publiée deux fois
        seenFiles.add(file.toLowerCase());

        const title = clean(decodeEntities(c.title?.rendered ?? c.title));
        const code = fileCode(file);
        const titleCode = fileCode(title);
        // titre = nom de fichier ("TMNT01-238-C-ALT-ColdandCalculating") → on garde la partie nom
        const fileLike = !!(titleCode && titleCode.nameParts.length && !title.includes(', ') && (/\d/.test(titleCode.set) || titleCode.digits >= 3));
        const keys = new Map();
        const add = (s, q) => { const k = norm(s); if (k && (keys.get(k) || 0) < q) keys.set(k, q); };
        if (fileLike) add(titleCode.nameParts.join(''), 3);
        else if (title) {
            const t = stripTag(title);
            add(t, 3);
            if (t.includes('//')) add(t.split('//')[0], 3);
            add(t.replace(/\s*\([^()]*\)\s*$/, ''), 2);
            add(t.replace(/[\s.]+(?:ALT|Alt|alt|I{1,3}|IV|VI{0,3})$/, ''), 2); // "Acid Screen ALT", "All Might. IV"
        }
        if (code?.nameParts.length) add(code.nameParts.join(''), 2);
        const w = media.media_details?.width, h = media.media_details?.height;
        const tags = `${title} ${file}`;
        images.push({
            wpId: c.id, title, file, url: media.source_url, isHorizontal: !!(w && h && w > h),
            series: names(c, 'card-series')[0], types: names(c, 'card-type'), code, keys,
            alt: !!code?.markers.some(m => /ALT$/.test(m)) || /(^|[-_ ])alt([-_ .]|$)|alternate|alt\.?\s?art/i.test(tags),
            chrome: /chrome/i.test(tags),
        });
    }
    summary.uvsCount = images.length + summary.uvsDuplicates;
    return images;
}

// ─────────────────────────────── Images ↔ impressions ───────────────────────────────

/** Score d'une image uvsgames.com pour une impression uvscards.fyi (le nom correspond déjà) */
function pairScore(f, u, nameQ) {
    let s = nameQ;
    if (u.code && f.no !== undefined && u.code.num === f.no) s += 4;
    if (u.code?.set && f.slug && (norm(u.code.set) === f.slug || norm(u.code.first) === f.slug)) s += 3;
    if (u.series) s += Math.round(3 * setSimilarity(u.series, f.set));
    if (u.alt || u.chrome) s += (u.alt && f.kind === 'alt-art') || (u.chrome && f.kind === 'chrome') ? 2 : -2;
    else if (f.kind === 'official') s += 1;
    if (f.isDfc && u.code?.face === 'b') s -= 3; // le verso n'est pas le recto
    return s;
}

function matchImages(printings, images, summary) {
    const byKey = new Map();
    for (const u of images) {
        u.longest = Math.max(0, ...[...u.keys.keys()].map(k => k.length));
        for (const [k, q] of u.keys) groupPush(byKey, k, { u, q });
    }

    // 1. par nom : toutes les paires (impression, image) dont un nom correspond, les meilleures d'abord
    const pairs = [];
    for (const f of printings) {
        const best = new Map();
        // nom complet des deux côtés = 3 ; nom raccourci ou tiré du fichier d'un côté = 2 ; des deux côtés = 1
        // + 2 si c'est le nom le plus précis de l'image (titre "Armin Arlert" mais fichier "ArminArlertScaredStrategist")
        for (const [k, q] of f.keys) {
            for (const { u, q: uq } of byKey.get(k) || []) best.set(u, Math.max(best.get(u) || 0, q + uq - 3 + (k.length === u.longest ? 2 : 0)));
        }
        for (const [u, q] of best) pairs.push({ f, u, s: pairScore(f, u, q) });
    }
    pairs.sort((a, b) => b.s - a.s || a.u.wpId - b.u.wpId || a.f.idx - b.f.idx);
    for (const { f, u } of pairs) {
        if (f.image || u.used) continue;
        f.image = u; f.how = 'name'; u.used = f;
    }

    // 2. par numéro, pour les noms écrits autrement ("Forty Five Percent" / "45%", fautes de frappe) :
    //    code d'image appris des correspondances de l'étape 1 (set uvscards.fyi → "TK802"), même numéro, nom proche
    const codeOfSet = new Map();
    for (const f of printings) if (f.image?.code && f.image.code.num === f.no) vote(codeOfSet, f.set, f.image.code.set);
    const free = new Map();
    for (const u of images) if (!u.used && u.code) groupPush(free, `${u.code.set}#${u.code.num}`, u);
    for (const f of printings) {
        if (f.image || f.no === undefined) continue;
        const code = majority(codeOfSet.get(f.set));
        const cands = (free.get(`${code}#${f.no}`) || []).filter(u => !u.used && !(f.isDfc && u.code.face === 'b') &&
            [...f.keys.keys()].some(fk => [...u.keys.keys()].some(uk => closeNames(fk, uk))));
        if (!cands.length) continue;
        cands.sort((a, b) => pairScore(f, b, 0) - pairScore(f, a, 0) || a.wpId - b.wpId);
        f.image = cands[0]; f.how = 'number'; cands[0].used = f;
    }

    // 2b. même numéro et nom proche, quel que soit le code ("MHACCG-S6-PU_09_HackerExtrodinaire" ↔ "Hacker Extraordinaire" #9)
    const freeByNum = new Map();
    for (const u of images) if (!u.used && u.code) groupPush(freeByNum, u.code.num, u);
    for (const f of printings) {
        if (f.image || f.no === undefined) continue;
        const cands = (freeByNum.get(f.no) || []).filter(u => !u.used && !(f.isDfc && u.code.face === 'b') &&
            [...f.keys.keys()].some(fk => [...u.keys.keys()].some(uk => closeNames(fk, uk))));
        if (!cands.length) continue;
        cands.sort((a, b) => pairScore(f, b, 0) - pairScore(f, a, 0) || a.wpId - b.wpId);
        f.image = cands[0]; f.how = 'number'; cands[0].used = f;
    }

    // 3. versos des cartes recto-verso : image avec le nom du verso (même approché), ou même code + même numéro + face "b"
    const free3 = images.filter(u => !u.used);
    for (const f of printings) {
        if (!f.isDfc || !f.image) continue;
        summary.dfc++;
        const backName = clean(f.name.split('//')[1]);
        const keys = [norm(backName), backName.includes(',') ? norm(backName.split(',')[0]) : null].filter(Boolean);
        const fc = f.image.code;
        const cands = free3.filter(u => !u.used && (
            [...u.keys.keys()].some(uk => keys.some(k => { const max = Math.floor(Math.min(uk.length, k.length) / 5); return levenshtein(uk, k, max) <= max; })) ||
            (fc && u.code && u.code.set === fc.set && u.code.num === fc.num && u.code.face === 'b')));
        if (!cands.length) continue;
        const sc = u => (u.code && f.image.code && u.code.set === f.image.code.set ? 3 : 0) + (u.code && f.image.code && u.code.num === f.image.code.num ? 4 : 0) +
            (u.code?.face === 'b' ? 1 : 0) + ((u.alt || u.chrome) === (f.image.alt || f.image.chrome) ? 1 : 0);
        cands.sort((a, b) => sc(b) - sc(a) || a.wpId - b.wpId);
        f.back = cands[0]; cands[0].used = f;
        summary.backs++;
    }
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = {
        fyiGenerated: '', fyiCards: 0, fyiPrintings: 0, uvsCount: 0, uvsDuplicates: 0, byName: 0, byNumber: 0, fyiImages: 0,
        dropped: 0, dfc: 0, backs: 0, unusedUvs: 0, special: 0, cardCount: 0, previousCount: 0, legacy: 0, nameCount: 0,
        added: [], kept: [], bySet: [], types: [], fatal: null,
    };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const previousAll = await readJsonIfExists(cardsPath, {});
        const previousCards = {};
        for (const [id, e] of Object.entries(previousAll)) {
            if (LEGACY_ID.test(id)) summary.legacy++; // ancienne version (id WordPress) : remplacée, pas conservée
            else previousCards[id] = e;
        }
        summary.previousCount = Object.values(previousCards).filter(e => !e?.aliasOf).length;

        // ── 1. Sources ──
        const printings = await loadFyi(summary);
        const images = await loadUvs(summary);

        // ── 2. Images uvsgames.com ↔ impressions uvscards.fyi ──
        matchImages(printings, images, summary);

        // ── 3. Cartes ──
        const out = {};
        const kept = [];
        const noImage = new Map(), setStats = new Map(), types = new Map();
        for (const f of printings) {
            const uvsTypes = f.image?.types || [];
            if ([f.type, ...uvsTypes].some(t => EXCLUDED_TYPES.test(t))) { summary.special++; continue; }
            f.isToken = [f.type, ...uvsTypes].some(t => TOKEN_TYPES.test(t));
            const s = setStats.get(f.set) || { name: f.set, sr: num(f.p.sr), total: 0, uvs: 0, fyi: 0, none: 0 };
            s.total++;
            if (s.sr === undefined && num(f.p.sr) !== undefined) s.sr = num(f.p.sr);
            setStats.set(f.set, s);

            let image = f.image, back = f.back;
            if (!image && CONFIG.useFyiImages && f.p.img) {
                image = { url: `${CONFIG.fyiImageBase}/${String(f.p.img).replace(/^\/+/, '')}`, isHorizontal: false };
                summary.fyiImages++; s.fyi++;
            } else if (image) {
                s.uvs++;
                if (f.how === 'number') summary.byNumber++; else summary.byName++;
            }
            if (!back && image && f.isDfc && CONFIG.useFyiImages && f.p.back) back = { url: `${CONFIG.fyiImageBase}/${String(f.p.back).replace(/^\/+/, '')}`, isHorizontal: false };
            if (!image) { summary.dropped++; s.none++; groupPush(noImage, f.set, f); continue; }
            if (f.isDfc && !back) report('warning', 'Cartes recto-verso sans image du verso (recto seul)', f.id, f.name);

            out[f.id] = buildCardEntry(f, image, back);
            types.set(f.type, (types.get(f.type) || 0) + 1);
        }
        for (const [set, list] of noImage) {
            report('warning', 'Impressions sans image uvsgames.com (pas dans la liste)', set,
                `${list.length} impression(s), ex : ${list.slice(0, 4).map(f => `${f.name} #${f.no ?? '?'} (${f.kind})`).join(' ; ')}`);
        }
        const unused = images.filter(u => !u.used);
        summary.unusedUvs = unused.length;
        const unusedBy = new Map();
        for (const u of unused) groupPush(unusedBy, u.series || u.code?.set || 'sans série ni code', u);
        for (const [key, list] of [...unusedBy].sort((a, b) => b[1].length - a[1].length)) {
            report('warning', 'Images uvsgames.com non reliées à une carte uvscards.fyi', key,
                `${list.length} image(s), ex : ${list.slice(0, 4).map(u => `${u.title} (${u.file})`).join(' ; ')}`);
        }

        const realIds = Object.keys(out);
        if (!realIds.length) throw new FatalError('Aucune carte avec une image');
        if (summary.previousCount && realIds.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} cartes contre ${summary.previousCount} dans le ${CONFIG.cardsFile} actuel. ` +
                'Probable problème côté uvscards.fyi ou uvsgames.com. Relancer avec FORCE=1 pour écraser quand même.');
        }

        // ── 4. Comparaison avec la semaine précédente ──
        summary.added = realIds.filter(id => !(id in previousCards)).map(id => out[id]);
        for (const [id, prev] of Object.entries(previousCards)) {
            if (out[id]) continue;
            out[id] = prev; // aucune carte perdue pour les decks existants
            kept.push(id);
            report('warning', 'Cartes disparues (conservées telles quelles)', id, prev?.name || prev?.aliasOf || '');
        }
        summary.kept = kept;

        // ── 5. Écriture : sets du plus récent au plus ancien, puis numéro, type d'impression ──
        const info = new Map(printings.map(f => [f.id, f]));
        const rank = f => num(f.p.sr) ?? setStats.get(f.set)?.sr ?? 999;
        const sorted = Object.keys(out).sort((a, b) => {
            const fa = info.get(a), fb = info.get(b);
            if (!fa || !fb || !out[a].face || !out[b].face) return (fa ? 0 : 1) - (fb ? 0 : 1) || a.localeCompare(b);
            return rank(fa) - rank(fb) || fa.set.localeCompare(fb.set, 'en', { numeric: true }) ||
                (fa.no ?? 1e9) - (fb.no ?? 1e9) || KIND_ORDER.indexOf(fa.kind) - KIND_ORDER.indexOf(fb.kind) || fa.name.localeCompare(fb.name);
        });
        await writeFileAtomic(cardsPath, JSON.stringify(Object.fromEntries(sorted.map(k => [k, out[k]])), null, 2) + '\n');
        summary.cardCount = Object.values(out).filter(e => !e.aliasOf).length;
        summary.nameCount = new Set(Object.values(out).filter(e => !e.aliasOf).map(e => e.name)).size;
        summary.bySet = [...setStats.values()].sort((a, b) => (a.sr ?? 999) - (b.sr ?? 999) || a.name.localeCompare(b.name));
        summary.types = [...types.entries()].sort((a, b) => b[1] - a[1]);

        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes, ${summary.nameCount} noms différents ` +
            `(${summary.added.length} nouvelles, ${summary.kept.length} disparues conservées)`);
        console.log(`   images uvsgames.com : ${summary.byName} par nom + ${summary.byNumber} par numéro, versos : ${summary.backs}/${summary.dfc}` +
            `${CONFIG.useFyiImages ? `, images uvscards.fyi : ${summary.fyiImages}` : ''}, sans image : ${summary.dropped}, images uvsgames.com non utilisées : ${summary.unusedUvs}`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    if (!summary.fatal || issues.length) printIssuesToConsole();
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
